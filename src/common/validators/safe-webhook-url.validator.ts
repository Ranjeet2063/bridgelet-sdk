import { registerDecorator, ValidationOptions } from 'class-validator';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '169.254.169.254', // cloud metadata endpoint (AWS/GCP/Azure)
  '::1',
]);

function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 || // private
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) // link-local / metadata
  );
}

export function IsSafeWebhookUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeWebhookUrl',
      target: object.constructor,
      propertyName,
      options: {
        message:
          `${propertyName} must not target an internal, loopback, ` +
          'link-local, or cloud-metadata address',
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          try {
            const hostname = new URL(value).hostname.toLowerCase();
            if (BLOCKED_HOSTNAMES.has(hostname)) return false;
            return !isBlockedIpv4(hostname);
          } catch {
            return false;
          }
        },
      },
    });
  };
}
