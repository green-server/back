export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const invalid = (message: string) => new ApiError(400, 'validation_error', message);
export const notFound = () => new ApiError(404, 'not_found', '찾을 수 없습니다.');
export const agentOffline = () => new ApiError(409, 'agent_offline', '에이전트가 연결되어 있지 않습니다.');

export const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export const isNumber = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseId(v: unknown): number | null {
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) return null;
  const id = Number(v);
  return Number.isSafeInteger(id) ? id : null;
}
