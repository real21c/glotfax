import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type JournalStatus = 'sending' | 'sent' | 'failed';

interface Entry {
  jobId: string;
  attempt: number;
  status: JournalStatus;
  detail?: string;
  at: number;
}

export interface FinalReport {
  jobId: string;
  attempt: number;
  status: 'sent' | 'failed';
  detail?: string;
}

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 에이전트가 손댄 작업 기록. 같은 팩스를 두 번 보내지 않기 위해 (작업, 시도) 단위로 남긴다.
 * - 이미 끝난 시도가 다시 오면 결과만 다시 보고
 * - 'sending' 인 채로 남아 있으면 (전송 중 에이전트가 꺼짐) 다시 보내지 않고 결과 불명으로 처리
 * 다시 보내기는 서버가 시도 번호를 올려서 보내므로 새 시도로 처리된다.
 */
export class Journal {
  private readonly file: string;
  private entries: Record<string, Entry> = {};

  constructor(dataDir: string) {
    this.file = join(dataDir, 'journal.json');
  }

  async load(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.entries = {};
    }
  }

  get(jobId: string, attempt: number): Entry | undefined {
    return this.entries[key(jobId, attempt)];
  }

  async set(jobId: string, attempt: number, status: JournalStatus, detail?: string): Promise<void> {
    this.entries[key(jobId, attempt)] = { jobId, attempt, status, detail, at: Date.now() };
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, e] of Object.entries(this.entries)) if (e.at < cutoff) delete this.entries[k];
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entries));
    await rename(tmp, this.file);
  }

  /** 최근 끝난 시도들. 연결할 때 서버에 다시 알려 놓친 보고를 메운다 */
  recentFinal(limit = 50): FinalReport[] {
    return Object.values(this.entries)
      .filter((e): e is Entry & { status: 'sent' | 'failed' } => e.status !== 'sending')
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map(({ jobId, attempt, status, detail }) => ({ jobId, attempt, status, detail }));
  }
}

function key(jobId: string, attempt: number): string {
  return `${jobId}#${attempt}`;
}
