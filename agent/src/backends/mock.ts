import { setTimeout as sleep } from 'node:timers/promises';
import type { FaxBackend, SendInput, SendResult } from './types.ts';

/**
 * 실제로 보내지 않는 개발용 백엔드. 번호가 000 으로 시작하면 실패.
 * succeed=false 면 모든 작업을 실패로 보고한다 (운영에서 실제 백엔드 준비 전: 완료로 착각하지 않게, 나중에 다시 보내기 가능)
 */
export class MockBackend implements FaxBackend {
  readonly name = 'mock';
  private readonly delayMs: number;
  private readonly succeed: boolean;

  constructor(delayMs: number, succeed = true) {
    this.delayMs = delayMs;
    this.succeed = succeed;
  }

  async send({ faxNumber }: SendInput): Promise<SendResult> {
    await sleep(this.delayMs);
    if (!this.succeed) return { ok: false, detail: '테스트 모드라 실제로 보내지 않았어요. 다시 보내기로 보내 주세요.' };
    if (faxNumber.startsWith('000')) return { ok: false, detail: '[mock] 연결되지 않는 번호' };
    return { ok: true, detail: '[mock] 전송한 것으로 처리' };
  }
}
