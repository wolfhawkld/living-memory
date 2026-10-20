/** Learning semantics handshake. Never infer support from an ignored request header. */
export const LEARNING_PROTOCOL_VERSION = 2 as const;
export const LEARNING_PROTOCOL_HEADER = 'X-LM-Learning-Protocol';
export const LEARNING_PROTOCOL_ERROR = 'LEARNING_PROTOCOL_REQUIRED';
export const LEARNING_PROTOCOL_MESSAGE = '学习数据协议不兼容，请升级客户端和服务后重新连接。';
export function supportsLearningProtocol(value: unknown): value is typeof LEARNING_PROTOCOL_VERSION {
  return value === LEARNING_PROTOCOL_VERSION;
}
/** Only these upgrade/session endpoints are exempt from the learning handshake. */
export function isLearningProtocolExempt(path: string): boolean {
  const pathname = path.split('?')[0].replace(/\/$/, '');
  return pathname === '/session' || pathname === '/health' || pathname.startsWith('/auth/');
}
