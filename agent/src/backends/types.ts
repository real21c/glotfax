export interface SendInput {
  jobId: string;
  filePath: string;
  faxNumber: string;
  /** 진행 단계를 알린다 (보낸 기록의 "보내는 중" 밑에 쌓임) */
  progress?: (text: string, at?: Date) => void;
}

export interface SendResult {
  ok: boolean;
  detail?: string;
}

/** 제조사별로 팩스를 실제로 보내는 부분. 새 제조사는 이 인터페이스만 구현하면 된다 */
export interface FaxBackend {
  readonly name: string;
  send(input: SendInput): Promise<SendResult>;
}
