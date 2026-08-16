import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DownloadResponse {
  statusCode: number;
  location?: string;
  body?: AsyncIterable<Uint8Array>;
  cancel?: () => Promise<void>;
}

export interface NetworkDependencies {
  download?: (url: URL, address: ResolvedAddress) => Promise<DownloadResponse>;
  hostnamePolicy?: (hostname: string) => boolean | Promise<boolean>;
  resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>;
}

type SourceFailure = (code: string, message: string, hint?: string) => Error;

const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000],
  [0x0a000000, 0xff000000],
  [0x64400000, 0xffc00000],
  [0x7f000000, 0xff000000],
  [0xa9fe0000, 0xffff0000],
  [0xac100000, 0xfff00000],
  [0xc0000000, 0xffffff00],
  [0xc0000200, 0xffffff00],
  [0xc0586300, 0xffffff00],
  [0xc0a80000, 0xffff0000],
  [0xc6120000, 0xfffe0000],
  [0xc6336400, 0xffffff00],
  [0xcb007100, 0xffffff00],
  [0xe0000000, 0xe0000000],
];

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second, third, fourth] = address.split('.').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const value = (first * 0x1000000 + (second << 16) + (third << 8) + fourth) >>> 0;
  return !NON_PUBLIC_V4.some(([network, mask]) => (value & mask) >>> 0 === network);
}

function ipv6Words(address: string): number[] {
  const halves = address.split('::');
  const leftText = halves[0] as string;
  const rightText = halves[1] as string | undefined;
  const left = leftText === '' ? [] : leftText.split(':');
  const right = rightText === undefined || rightText === '' ? [] : rightText.split(':');
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array.from({ length: zeros }, () => '0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
}

function publicIpv6(address: string): boolean {
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const words = ipv6Words(address.toLowerCase());
  const first = words[0] as number;
  const second = words[1] as number;
  const allZeroPrefix = words.slice(0, 6).every((word) => word === 0);
  return (
    (first & 0xe000) === 0x2000 &&
    !allZeroPrefix &&
    !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) &&
    first !== 0x2002 &&
    !(first >= 0x3ff0 && first <= 0x3fff)
  );
}

export function isPublicAddress(address: string): boolean {
  return publicIpv4(address) || publicIpv6(address);
}

function normalizedHostname(url: URL): string {
  const bracketless = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return bracketless.toLowerCase().replace(/\.+$/u, '');
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

export async function resolvePublicTarget(
  url: URL,
  dependencies: NetworkDependencies,
  fail: SourceFailure,
): Promise<ResolvedAddress> {
  const hostname = normalizedHostname(url);
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw fail('SOURCE_HOST_REJECTED', '远程 source 主机被安全策略拒绝。');
  }
  if (isIP(hostname) === 0) url.hostname = hostname;
  if (dependencies.hostnamePolicy !== undefined && !(await dependencies.hostnamePolicy(hostname))) {
    throw fail('SOURCE_HOST_REJECTED', '远程 source 主机被安全策略拒绝。');
  }
  let addresses: ResolvedAddress[];
  const literalFamily = isIP(hostname);
  try {
    addresses =
      literalFamily === 0
        ? await (dependencies.resolveHostname ?? defaultResolve)(hostname)
        : [{ address: hostname, family: literalFamily as 4 | 6 }];
  } catch {
    throw fail('SOURCE_HOST_REJECTED', '远程 source 主机无法安全解析。');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw fail('SOURCE_HOST_REJECTED', '远程 source 主机被安全策略拒绝。');
  }
  return addresses[0] as ResolvedAddress;
}

export function fixedLookup(target: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [target]);
    else callback(null, target.address, target.family);
  };
}

export async function defaultDownload(
  url: URL,
  target: ResolvedAddress,
): Promise<DownloadResponse> {
  const agent = new Agent({ connect: { lookup: fixedLookup(target) } });
  const response = await request(url, {
    dispatcher: agent,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const location = response.headers.location;
  const body = (async function* () {
    try {
      for await (const chunk of response.body) yield chunk;
    } finally {
      await agent.close();
    }
  })();
  return {
    statusCode: response.statusCode,
    ...(typeof location === 'string' ? { location } : {}),
    body,
    cancel: async () => {
      response.body.destroy();
      await agent.close();
    },
  };
}
