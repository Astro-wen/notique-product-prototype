"use client";

import { ArrowLeft } from "lucide-react";

/**
 * 「这东西怎么工作」页。
 *
 * 读者是要判断这份报告能不能信的人，不是工程师。所以讲的是一份材料进来之后
 * 依次经过哪几道手、每道手交出什么、哪一步会拦住错误，以及最后为什么还是要人
 * 点头。图和文字都跟着真实实现走：阅读线见 lib/domain/reading-pipeline.ts，
 * 事实线见 lib/domain/two-stage-extraction.ts 和 lib/server/jobs/extraction-processor.ts，
 * 引用判断见 lib/domain/support-judge.ts。
 *
 * 引用判断（createJevSupportJudge）目前没有任何任务调用它。图里保留这个节点，
 * 但画成虚线并标明未上线，免得读者以为它在跑。
 */

type Tone = "input" | "read" | "fact" | "human";

type Box = {
  id: string;
  x: number;
  y: number;
  w: number;
  label: string;
  /** 最多两行，每行一条 text，SVG 不会自动折行。 */
  sub?: [string] | [string, string];
  tone: Tone;
  /** 做好了但没接进任何任务。 */
  pending?: boolean;
};

/*
 * 竖排：最上面是输入，中间左右两条线并排往下走，最后汇到底部的人工确认。
 * 阅读线四个 agent 同一排并行，所以左边的带子比右边宽；事实线是先后接力，竖着排。
 */
const H = 66;
const VIEW_W = 960;
const VIEW_H = 700;

const READ_LANE_X = 16;
const READ_LANE_W = 536;
const FACT_LANE_X = READ_LANE_X + READ_LANE_W + 16;
const FACT_LANE_W = VIEW_W - FACT_LANE_X - 16;
const LANE_Y = 118;
const LANE_H = 428;
const NODE_W = 320;
/** 阅读线四个并排的 agent：四个 124 宽加三道 8 的缝。 */
const QUARTER_W = 124;
const QUARTER_GAP = 8;
const ROW = [160, 256, 352, 448] as const;

const factNodeX = FACT_LANE_X + (FACT_LANE_W - NODE_W) / 2;
const quarterX = (index: number) =>
  READ_LANE_X + (READ_LANE_W - 4 * QUARTER_W - 3 * QUARTER_GAP) / 2 + index * (QUARTER_W + QUARTER_GAP);

const BOXES: Box[] = [
  { id: "material", x: 210, y: 20, w: 220, label: "材料", sub: ["音频、已有逐字稿、照片"], tone: "input" },
  { id: "transcript", x: 530, y: 20, w: 220, label: "逐字稿", sub: ["语音识别服务转写，不是 agent", "带时间点和说话人"], tone: "input" },

  // 逐字稿一出来四个同时开工，各读一遍原文，谁先写完谁先显示。
  { id: "chapters", x: quarterX(0), y: ROW[0], w: QUARTER_W, label: "章节 agent", sub: ["读全文分章"], tone: "read" },
  { id: "speakers", x: quarterX(1), y: ROW[0], w: QUARTER_W, label: "发言总结 agent", sub: ["读全文按人总结"], tone: "read" },
  { id: "points", x: quarterX(2), y: ROW[0], w: QUARTER_W, label: "要点回顾 agent", sub: ["读全文整理问答"], tone: "read" },
  { id: "overview", x: quarterX(3), y: ROW[0], w: QUARTER_W, label: "全文概要 agent", sub: ["读全文写概要"], tone: "read" },

  { id: "inventory", x: factNodeX, y: ROW[0], w: NODE_W, label: "清点 agent", sub: ["交出：可能的事实清单，宁可多列"], tone: "fact" },
  { id: "verify", x: factNodeX, y: ROW[1], w: NODE_W, label: "核对 agent", sub: ["交出：逐条配上原话的事实", "和每条候选的去向"], tone: "fact" },
  { id: "escalate", x: factNodeX, y: ROW[2], w: NODE_W, label: "重核 agent", sub: ["丢了事实、有冲突时才跑", "两份里留下问题更少的"], tone: "fact" },
  { id: "judge", x: factNodeX, y: ROW[3], w: NODE_W, label: "引用判断 agent（未上线）", sub: ["已做好，还没接进任务", "现在核对结果直接到你手上"], tone: "fact", pending: true },

  { id: "human", x: 280, y: 586, w: 400, label: "你逐条确认", sub: ["确认过的才进报告"], tone: "human" },
];

const EDGES: Array<[string, string]> = [
  ["material", "transcript"],
  ["transcript", "chapters"],
  ["transcript", "speakers"],
  ["transcript", "points"],
  ["transcript", "overview"],
  ["transcript", "inventory"],
  ["inventory", "verify"],
  ["verify", "escalate"],
  ["escalate", "judge"],
  ["judge", "human"],
  // 四条从同一排往下走，拐在同一高度，看起来是一条汇总线。
  ["chapters", "human"],
  ["speakers", "human"],
  ["points", "human"],
  ["overview", "human"],
];

function box(id: string): Box {
  const found = BOXES.find((item) => item.id === id);
  if (!found) throw new Error(`unknown box: ${id}`);
  return found;
}

/**
 * 正交折线。同一行直接横穿；其余从上一个的底边出发，在两者之间的空隙里
 * 拐到下一个的中线再往下。7 是给箭头留的位置。
 */
function edgePath(fromId: string, toId: string): string {
  const from = box(fromId);
  const to = box(toId);
  const fromCenter = from.x + from.w / 2;
  const toCenter = to.x + to.w / 2;

  if (Math.abs(from.y - to.y) < 1) {
    return `M ${from.x + from.w} ${from.y + H / 2} L ${to.x - 7} ${to.y + H / 2}`;
  }

  const y1 = from.y + H;
  const y2 = to.y - 7;
  if (Math.abs(fromCenter - toCenter) < 1) return `M ${fromCenter} ${y1} L ${fromCenter} ${y2}`;
  // 从输入行进带子的线在带子上方就拐，不然横线会压在带子的标题上。
  const mid = from.y < LANE_Y ? y1 + 16 : y1 + (to.y - y1) / 2;
  return `M ${fromCenter} ${y1} L ${fromCenter} ${mid} L ${toCenter} ${mid} L ${toCenter} ${y2}`;
}

/** 进出未上线节点的线也画成虚线，免得看起来像在跑。 */
function edgePending(fromId: string, toId: string): boolean {
  return Boolean(box(fromId).pending || box(toId).pending);
}

export function HowItWorks({ onBack }: { onBack: () => void }) {
  return (
    <div className="page narrow-page hiw">
      <button className="text-button hiw-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />返回首页
      </button>

      <header className="hiw-head">
        <h1>使用说明</h1>
        <p>
          上传录音或逐字稿，系统整理成能读的版本，同时把每条结论配上原话。你确认过的才进报告。
        </p>
      </header>

      <figure className="hiw-figure">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-labelledby="hiw-diagram-title">
          <title id="hiw-diagram-title">
            材料先由语音识别服务转成逐字稿。逐字稿一出来，阅读线的章节、发言总结、要点回顾、全文概要
            四个 agent 和事实线的清点 agent 同时开工；事实线接着由核对 agent 配原话，出问题时重核 agent
            再核一遍，引用判断 agent 已做好但未上线。两条线最后都汇到你逐条确认。
          </title>
          <defs>
            <marker id="hiw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>

          <g className="hiw-band">
            <rect x={READ_LANE_X} y={LANE_Y} width={READ_LANE_W} height={LANE_H} rx="12" />
            <text x={READ_LANE_X + 14} y={LANE_Y + 24}>阅读线　让人能看懂这场对话</text>
            <rect x={FACT_LANE_X} y={LANE_Y} width={FACT_LANE_W} height={LANE_H} rx="12" />
            <text x={FACT_LANE_X + 14} y={LANE_Y + 24}>事实线　把结论钉回原话</text>
          </g>

          <g className="hiw-edges">
            {EDGES.map(([from, to]) => (
              <path
                key={`${from}-${to}`}
                d={edgePath(from, to)}
                markerEnd="url(#hiw-arrow)"
                strokeDasharray={edgePending(from, to) ? "5 4" : undefined}
              />
            ))}
          </g>

          {BOXES.map((item) => {
            const lines = item.sub?.length ?? 0;
            const labelY = item.y + (lines === 2 ? 22 : lines === 1 ? 26 : 39);
            return (
              <g key={item.id} className={`hiw-box tone-${item.tone}${item.pending ? " hiw-box-pending" : ""}`}>
                <rect x={item.x} y={item.y} width={item.w} height={H} rx="9" />
                <text x={item.x + item.w / 2} y={labelY} className="hiw-box-label">{item.label}</text>
                {item.sub?.map((line, index) => (
                  <text key={line} x={item.x + item.w / 2} y={labelY + 17 + index * 15} className="hiw-box-sub">{line}</text>
                ))}
              </g>
            );
          })}
        </svg>
      </figure>

      <ol className="hiw-steps">
        <li>
          <h2>上传材料</h2>
          <p>
            录音、已有的逐字稿、手写笔记的照片都能进来。上传第一份时项目自动建好，不用先想名字。
            同一场沟通的几份材料归在一条记录下面。
          </p>
        </li>
        <li>
          <h2>转写</h2>
          <p>
            这一步交给语音识别服务，不是 agent。它分出说话人和每句话的时间。长录音切块并行处理，
            中断了能接着跑。后面每一步都建在逐字稿上，报告里任何一句话都要能指回这里的某一句。
          </p>
        </li>
        <li>
          <h2>整理成能读的版本</h2>
          <p>
            逐字稿一出来，章节、发言总结、要点回顾、全文概要四个 agent 同时开工，各自读一遍原文，
            谁先写完谁先显示，还没写完的位置显示「内容生成中」。章节 agent 交出章节和每章的时间范围；
            发言总结和要点回顾开工时章节已经出来，就拿它当目录。
          </p>
          <p className="hiw-aside">
            四样各自独立，一样失败不影响其余，失败的那一样可以单独重新生成。章节没生成出来时，
            会先按时间粗分一份目录，并标明是粗分。
          </p>
        </li>
        <li>
          <h2>判断该放进哪个项目</h2>
          <p>
            概要和章节都出来之后，系统拿它们和已有的项目比一次。够确定才会在记录上出现一条建议，说它可能
            该放进哪个项目，不够确定就不出现。点挪过去，这条记录连同材料和逐字稿一起搬走。
            不点就什么都不会发生。
          </p>
          <p className="hiw-aside">
            上传时自己挑过项目的，这条建议不会出现。已经有人确认过内容的记录不能挪，
            确认过的结论属于它所在项目的账本。
          </p>
        </li>
        <li>
          <h2>找出事实，配上原话</h2>
          <p>
            清点 agent 读逐字稿，把可能的事实列全，宁可多列，交出一份候选清单。核对 agent 拿着
            清单和逐字稿逐条配原话，该合并的合并，该丢的丢，并交代每条为什么留下或去掉。
            分成两遍，是因为找得全和判得准放在一次里做，模型会为了少出错而漏掉东西。
          </p>
        </li>
        <li>
          <h2>重核，只在出问题时</h2>
          <p>
            核对完有一道不靠模型的检查：格式不合契约、清点里的条目没有交代去向、标为关键的事实被丢掉、
            关系判断信心不足（低于 0.85）、留下未解决的冲突、之前标过的问题又出现。任何一种命中，
            重核 agent 再核对一遍，两份里留下问题更少的那份。都没中就不重做，不额外花钱。
          </p>
          <p className="hiw-aside">
            一条里塞了两件事不再单独触发重核：实测重核从没因此补回过事实，每次却要多等一两分钟。
            这样的条目照常交给你确认，你可以直接改。
          </p>
        </li>
        <li>
          <h2>引用判断（未上线）</h2>
          <p>
            这一步做好了，还没接进任何任务，现在核对结果直接到你手上。接上之后它只判断一条结论
            和它的原话搭不搭，而且只会把记录往更不可信的方向推。说撑不住就标出来并挡住一键确认，
            拿不准就把显示的强度降一档，说撑得住则什么都不做。
          </p>
          <p className="hiw-aside">
            不会出现“系统已核实”这种说法，确认只能由人做。判断方连不上或者没配，
            系统表现和现在完全一样。
          </p>
        </li>
        <li>
          <h2>确认</h2>
          <p>
            待确认的条目按风险排序，逐条看原话，确认或者否掉。报告、简报、待办只收确认过的，
            没确认的一直待在那里。所以报告里每句话都找得到出处。
          </p>
        </li>
      </ol>

      <section className="hiw-limits">
        <h2>不做什么</h2>
        <ul>
          <li>不替你确认。没人点过头的结论不会进报告，哪怕模型很有把握。</li>
          <li>不补原文里没有的事。找不到出处的结论会被丢掉，而不是被合理推测出来。</li>
          <li>不掩盖失败。某一步没跑成，界面直接说哪一步没成，而不是给一份看起来完整的东西。</li>
        </ul>
      </section>
    </div>
  );
}
