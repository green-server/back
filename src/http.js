export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalid = (message) => new ApiError(400, 'validation_error', message);
export const notFound = () => new ApiError(404, 'not_found', '찾을 수 없습니다.');
export const agentOffline = () => new ApiError(409, 'agent_offline', '에이전트가 연결되어 있지 않습니다.');

export const isText = (v, max) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export const isNumber = (v, min, max) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export const isObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseId(v) {
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) return null;
  const id = Number(v);
  return Number.isSafeInteger(id) ? id : null;
}
