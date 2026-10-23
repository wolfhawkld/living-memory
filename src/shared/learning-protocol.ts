/** Learning semantics handshake. Never infer support from an ignored request header. */
export const LEARNING_PROTOCOL_VERSION = 2 as const;
/** Client capability only. The server default and runtime gate remain v2. */
export type LearningProtocolVersion = 2 | 3;
export const LEARNING_PROTOCOL_HEADER = 'X-LM-Learning-Protocol';
export const LEARNING_PROTOCOL_ERROR = 'LEARNING_PROTOCOL_REQUIRED';
export const LEARNING_PROTOCOL_MESSAGE = '学习数据协议不兼容，请升级客户端和服务后重新连接。';
export function supportsLearningProtocol(value: unknown): value is LearningProtocolVersion {
  return value === 2 || value === 3;
}
/** Only these upgrade/session endpoints are exempt from the learning handshake. */
export function isLearningProtocolExempt(path: string): boolean {
  const pathname = path.split('?')[0].replace(/\/$/, '');
  return pathname === '/session' || pathname === '/health' || pathname.startsWith('/auth/');
}
