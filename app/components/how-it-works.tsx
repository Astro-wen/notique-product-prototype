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
 * 之前横排时每个节点只有 132 宽，写不下 agent 名字和它交出的东西，带子背景
 * 还越过了 viewBox 上边被裁掉。现在节点 320 宽，四周都留了边。
 */
const H = 66;
const VIEW_W = 960;
const VIEW_H = 700;

const LANE_W = 452;
const LANE_LEFT_X = 16;
const LANE_RIGHT_X = 492;
const LANE_Y = 118;
const LANE_H = 428;
const NODE_W = 320;
const HALF_W = 152;
const ROW = [160, 256, 352, 448] as const;

const laneNodeX = (laneX: number) => laneX + (LANE_W - NODE_W) / 2;

const BOXES: Box[] = [
  { id: "material", x: 210, y: 20, w: 220, label: "材料", sub: ["音频、已有逐字稿、照片"], tone: "input" },
  { id: "transcript", x: 530, y: 20, w: 220, label: "逐字稿", sub: ["语音识别服务转写，不是 agent", "带时间点和说话人"], tone: "input" },

  { id: "readable", x: laneNodeX(LANE_LEFT_X), y: ROW[0], w: NODE_W, label: "易读逐字稿 agent", sub: ["交出：断句加标点的稿子"], tone: "read" },
  { id: "chapters", x: laneNodeX(LANE_LEFT_X), y: ROW[1], w: NODE_W, label: "章节 agent", sub: ["唯一通读全文的一步", "交出：章节和每章的时间范围"], tone: "read" },
  { id: "speakers", x: laneNodeX(LANE_LEFT_X), y: ROW[2], w: HALF_W, label: "发言总结 agent", sub: ["拿章节当目录"], tone: "read" },
  { id: "points", x: laneNodeX(LANE_LEFT_X) + NODE_W - HALF_W, y: ROW[2], w: HALF_W, label: "要点回顾 agent", sub: ["拿章节当目录"], tone: "read" },
  { id: "overview", x: laneNodeX(LANE_LEFT_X), y: ROW[3], w: NODE_W, label: "全文概要 agent", sub: ["只读上面三样的产出，不读逐字稿"], tone: "read" },

  { id: "inventory", x: laneNodeX(LANE_RIGHT_X), y: ROW[0], w: NODE_W, label: "清点 agent", sub: ["交出：可能的事实清单，宁可多列"], tone: "fact" },
  { id: "verify", x: laneNodeX(LANE_RIGHT_X), y: ROW[1], w: NODE_W, label: "核对 agent", sub: ["交出：逐条配上原话的事实", "和每条候选的去向"], tone: "fact" },
  { id: "escalate", x: laneNodeX(LANE_RIGHT_X), y: ROW[2], w: NODE_W, label: "重核 agent", sub: ["七种情况任一命中才跑", "两份里留下问题更少的"], tone: "fact" },
  { id: "judge", x: laneNodeX(LANE_RIGHT_X), y: ROW[3], w: NODE_W, label: "引用判断 agent（未上线）", sub: ["已做好，还没接进任务", "现在核对结果直接到你手上"], tone: "fact", pending: true },

  { id: "human", x: 280, y: 586, w: 400, label: "你逐条确认", sub: ["确认过的才进报告"], tone: "human" },
];

const EDGES: Array<[string, string]> = [
  ["material", "transcript"],
  ["transcript", "readable"],
  ["readable", "chapters"],
  ["chapters", "speakers"],
  ["chapters", "points"],
  ["speakers", "overview"],
  ["points", "overview"],
  ["transcript", "inventory"],
  ["inventory", "verify"],
  ["verify", "escalate"],
  ["escalate", "judge"],
  ["judge", "human"],
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
        <h1>一份材料进来之后</h1>
        <p>
          材料先转成带时间点的逐字稿，然后分两条线走：阅读线把这场对话整理成能看懂的章节、
          发言总结、要点和概要；事实线把每条结论钉回原话。两条线的产出最后都到你手上，
          你逐条确认过的才写进报告。下面按顺序讲每一步做什么、交出什么、在哪里会被拦下来。
        </p>
      </header>

      <figure className="hiw-figure">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-labelledby="hiw-diagram-title">
          <title id="hiw-diagram-title">
            材料先由语音识别服务转成逐字稿，然后分两条线：阅读线依次由易读逐字稿、章节、发言总结和要点回顾、
            全文概要四个 agent 接力；事实线由清点、核对、重核三个 agent 接力，引用判断 agent 已做好但未上线。
            两条线最后都汇到你逐条确认。
          </title>
          <defs>
            <marker id="hiw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>

          <g className="hiw-band">
            <rect x={LANE_LEFT_X} y={LANE_Y} width={LANE_W} height={LANE_H} rx="12" />
            <text x={LANE_LEFT_X + 14} y={LANE_Y + 24}>阅读线　让人能看懂这场对话</text>
            <rect x={LANE_RIGHT_X} y={LANE_Y} width={LANE_W} height={LANE_H} rx="12" />
            <text x={LANE_RIGHT_X + 14} y={LANE_Y + 24}>事实线　把结论钉回原话</text>
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
          <h2>收下材料</h2>
          <p>
            录音、已有的逐字稿、手写笔记的照片都能进来。上传第一份时项目自动建好，不用先想名字。
            同一场沟通的几份材料归在一条记录下面。
          </p>
        </li>
        <li>
          <h2>转成带时间点的逐字稿</h2>
          <p>
            这一步交给语音识别服务，不是 agent。它分出说话人和每句话的时间。长录音切块并行处理，
            中断了能接着跑。逐字稿是后面一切的底：报告里任何一句话，最终都要能指回这里的某一句。
          </p>
        </li>
        <li>
          <h2>阅读线：四个 agent 接力</h2>
          <p>
            易读逐字稿 agent 给原稿断句、加标点，交出易读版。章节 agent 通读全文（有易读版就读易读版，
            没有就读原稿），交出章节和每章的时间范围；这是唯一需要通读全文的一步。发言总结 agent 和
            要点回顾 agent 拿章节当目录，按章取材；章节没出来就退回整篇读。全文概要 agent 只读上面
            三样的产出，不读逐字稿；上游一样都没有，它就不写。
          </p>
          <p className="hiw-aside">
            四样东西以前是一次调用的四个字段，一处格式出错四样全没；现在各自独立，一样失败不影响其余。
            每样产物按输入内容取身份，重试不会让已经做好的重做一遍。
          </p>
        </li>
        <li>
          <h2>事实线：先清点，再核对</h2>
          <p>
            清点 agent 读逐字稿，只管把可能的事实列全，宁可多列，交出一份候选清单。核对 agent 拿着清单
            和易读逐字稿，逐条配上原话，该合并的合并，该丢的丢，并交代每一条为什么留下或去掉。
            分成两遍，是因为找得全和判得准放在一次里做，模型会为了少出错而漏掉东西。
          </p>
        </li>
        <li>
          <h2>出问题才重核</h2>
          <p>
            核对完有一道不靠模型的检查，看七种情况：格式不合契约、清点里的条目没有交代去向、
            标为关键的事实被丢掉、关系判断信心不足（低于 0.85）、留下未解决的冲突、一条里塞了好几件事、
            之前标过的问题又出现。任何一种命中，重核 agent 再核对一遍，两份里留下问题更少的那份：
            先比丢掉的关键事实，再比没交代去向的条目。都没中就不重做，不额外花钱。
          </p>
        </li>
        <li>
          <h2>引用够不够硬（未上线）</h2>
          <p>
            这一步已经做好，但还没有接进任何任务，现在核对结果直接到你手上。接上以后它会这样工作：
            每条结论连着它的原话，只判断两者搭不搭。判断只会把一条记录往更不可信的方向推：
            说撑不住就标出来并挡住一键确认，拿不准就把显示的强度降一档，说撑得住则什么都不做。
          </p>
          <p className="hiw-aside">
            这里不会出现“系统已核实”。让机器替人确认，正是这个产品不能做的事。
            判断方连不上或者没配，系统表现和现在完全一样。
          </p>
        </li>
        <li>
          <h2>你点头，才写进报告</h2>
          <p>
            待确认的条目按风险排序，你逐条看原话，确认或者否掉。报告、简报、待办只收你确认过的，
            没确认的一直待在那里。所以报告里每句话都找得到出处，也都有人为它负责。
          </p>
        </li>
      </ol>

      <section className="hiw-limits">
        <h2>这套东西不做什么</h2>
        <ul>
          <li>不替你确认。没人点过头的结论不会进报告，哪怕模型很有把握。</li>
          <li>不补原文里没有的事。找不到出处的结论会被丢掉，而不是被合理推测出来。</li>
          <li>不掩盖失败。某一步没跑成，界面直接说哪一步没成，而不是给一份看起来完整的东西。</li>
        </ul>
      </section>
    </div>
  );
}
