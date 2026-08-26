import { TranscriptionRun } from "@/app/api-client";
import { displaySpeakerLabel } from "@/lib/domain/speaker-label";
import { formatTimestamp } from "@/lib/domain/display-format";
import { Modal } from "./modal";

export function TranscriptViewer({ run, onClose }: { run: TranscriptionRun; onClose: () => void }) {
  return (
    <Modal
      title="完整逐字稿"
      description={`${run.segments.length} 个带说话人和时间点的片段`}
      onClose={onClose}
      wide
    >
      <div className="full-transcript" data-testid="full-transcript">
        {run.segments.length > 0 ? run.segments.map((segment) => (
          <article key={segment.id}>
            <time>{formatTimestamp(segment.startMs / 1000)}</time>
            <strong>{displaySpeakerLabel(segment.speaker)}</strong>
            <p>{segment.text}</p>
          </article>
        )) : <p className="muted">服务器没有返回可显示的逐字稿片段。</p>}
      </div>
    </Modal>
  );
}
