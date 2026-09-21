"use client";

import { ArrowLeft } from "lucide-react";

/**
 * 「这东西怎么工作」页。
 *
 * 写给要判断这份报告能不能信的人看，不是写给工程师看的。所以讲的是一份材料
 * 进来之后依次经过哪几道手、每道手产出什么、哪一步会拦住错误，以及最后为什么
 * 还是要人点头。图和文字都跟着真实实现走：阅读线见 lib/domain/reading-pipeline.ts，
 * 事实线见 lib/domain/two-stage-extraction.ts，引用判断见 lib/domain/support-judge.ts。
 */

type Box = { id: string; x: number; y: number; w?: number; label: string; sub?: string; tone?: "input" | "read" | "fact" | "human" };

const W = 132;
const H = 56;

const BOXES: Box[] = [
  { id: "material", x: 8, y: 214, label: "材料", sub: "音频 / 文件 / 图片", tone: "input" },
  { id: "transcript", x: 168, y: 214, label: "逐字稿", sub: "带时间点和说话人", tone: "input" },

  { id: "readable", x: 328, y: 62, label: "易读逐字稿", sub: "断句和标点", tone: "read" },
  { id: "chapters", x: 488, y: 62, label: "章节速览", sub: "唯一通读全文的一步", tone: "read" },
  { id: "speakers", x: 648, y: 8, label: "发言总结", tone: "read" },
  { id: "points", x: 648, y: 116, label: "要点回顾", tone: "read" },
  { id: "overview", x: 808, y: 62, label: "全文概要", sub: "只读上面三样", tone: "read" },

  { id: "inventory", x: 328, y: 366, label: "清点", sub: "把可能的事实列全", tone: "fact" },
  { id: "verify", x: 488, y: 366, label: "核对", sub: "逐条配上原话", tone: "fact" },
  { id: "escalate", x: 648, y: 366, label: "重做一遍", sub: "只在出问题时", tone: "fact" },
  { id: "judge", x: 808, y: 366, label: "引用够不够硬", sub: "只会往下调", tone: "fact" },

  { id: "human", x: 808, y: 214, w: 132, label: "你逐条确认", sub: "确认过的才进报告", tone: "human" },
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
 * 正交折线。同一行直接横穿，同一列直接竖连（否则会绕出一条往回走的线），
 * 其余先走到两者中间那一列再上下对齐。7 是给箭头留的位置。
 */
function edgePath(fromId: string, toId: string): string {
  const from = box(fromId);
  const to = box(toId);
  const fromCenter = from.x + (from.w ?? W) / 2;
  const toCenter = to.x + (to.w ?? W) / 2;

  if (Math.abs(fromCenter - toCenter) < 1) {
    const down = to.y > from.y;
    const y1 = down ? from.y + H : from.y;
    const y2 = down ? to.y - 7 : to.y + H + 7;
    return `M ${fromCenter} ${y1} L ${fromCenter} ${y2}`;
  }

  const x1 = from.x + (from.w ?? W);
  const y1 = from.y + H / 2;
  const x2 = to.x;
  const y2 = to.y + H / 2;
  if (Math.abs(y1 - y2) < 1) return `M ${x1} ${y1} L ${x2 - 7} ${y2}`;
  const mid = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2 - 7} ${y2}`;
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
          从你把录音拖进来，到报告里出现一句话，中间经过七道手。这一页把每道手做什么、
          产出什么、在哪里会被拦下来讲清楚，你可以据此判断一句结论值不值得信。
        </p>
      </header>

      <figure className="hiw-figure">
        <svg viewBox="0 0 960 440" role="img" aria-labelledby="hiw-diagram-title">
          <title id="hiw-diagram-title">
            材料先转成逐字稿，然后分两条线：一条产出阅读用的章节、发言总结、要点回顾和全文概要，
            另一条清点并核对事实、必要时重做一遍、再判断引用够不够硬，最后都汇到你逐条确认。
          </title>
          <defs>
            <marker id="hiw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>

          <g className="hiw-band">
            <rect x="312" y="-14" width="640" height="212" rx="12" />
            <text x="324" y="10">阅读线　让人能看懂这场对话</text>
            <rect x="312" y="342" width="640" height="104" rx="12" />
            <text x="324" y="360">事实线　把结论钉回原话</text>
          </g>

          <g className="hiw-edges">
            {EDGES.map(([from, to]) => (
              <path key={`${from}-${to}`} d={edgePath(from, to)} markerEnd="url(#hiw-arrow)" />
            ))}
          </g>

          {BOXES.map((item) => (
            <g key={item.id} className={`hiw-box tone-${item.tone ?? "read"}`}>
              <rect x={item.x} y={item.y} width={item.w ?? W} height={H} rx="9" />
              <text x={item.x + (item.w ?? W) / 2} y={item.sub ? item.y + 24 : item.y + 33} className="hiw-box-label">
                {item.label}
              </text>
              {item.sub && (
                <text x={item.x + (item.w ?? W) / 2} y={item.y + 40} className="hiw-box-sub">{item.sub}</text>
              )}
            </g>
          ))}
        </svg>
        {/* 窄屏放不下整张图，横向滚动比把字压到看不清要好，但得说一声。 */}
        <figcaption>图比较宽，可以左右滑动看完；下面的文字说的是同一件事。</figcaption>
      </figure>

      <ol className="hiw-steps">
        <li>
          <h2>收下材料</h2>
          <p>
            录音、已有的逐字稿、手写笔记的照片都能进来。上传第一份的时候项目会自动建好，
            不用先想名字。同一场沟通的几份材料归在一条记录下面。
          </p>
        </li>
        <li>
          <h2>转成带时间点的逐字稿</h2>
          <p>
            音频先转写，分出说话人和每句话的时间。长录音会切块并行处理，中断了能接着跑。
            这一步的产出是后面一切的底：报告里任何一句话，最终都要能指回这里的某一句。
          </p>
        </li>
        <li>
          <h2>分头阅读，互相借力</h2>
          <p>
            章节速览是脊椎，也是唯一需要通读全文的一步。发言总结和要点回顾拿章节当目录按章取材，
            全文概要干脆不读原文，只读前面三样的产出。
          </p>
          <p className="hiw-aside">
            四样东西以前是一次调用的四个字段，一处格式出错四样全没；现在各自独立，一样失败不影响其余。
            每样产物按输入内容取身份，所以重试不会让已经做好的重做一遍。
          </p>
        </li>
        <li>
          <h2>先清点，再核对</h2>
          <p>
            清点这一遍只管把可能的事实列全，宁可多列；核对那一遍逐条配上原话，该合并的合并，
            该丢的丢，并说明每一条为什么留下或者去掉。分成两遍，是因为「找得全」和「判得准」
            放在一次里做，模型会为了少出错而漏掉东西。
          </p>
        </li>
        <li>
          <h2>出问题才重做</h2>
          <p>
            核对完有一道不靠模型的检查：格式不合契约、清点里的条目没有交代去向、
            标为关键的事实被丢掉、关系判断信心不足、留下未解决的冲突、一条里塞了好几件事、
            之前标过的问题又出现——七种情况里中任何一种，就再核对一遍，然后留下更完整的那一份。
            都没中就不重做，不额外花钱。
          </p>
        </li>
        <li>
          <h2>问一句：这段原话真撑得住这个结论吗</h2>
          <p>
            每条结论连着它的原话，这一步只判断两者搭不搭。判断只会把一条记录往「更不可信」推：
            说撑不住就标出来并挡住一键确认，拿不准就把显示的强度降一档，说撑得住则什么都不做。
          </p>
          <p className="hiw-aside">
            这里不会出现「系统已核实」。让机器替人确认，正是这个产品不能做的事。
            判断方连不上或者没配，系统表现和现在完全一样。
          </p>
        </li>
        <li>
          <h2>你点头，才写进报告</h2>
          <p>
            待确认的条目按风险排序，你逐条看原话、确认或者否掉。报告、简报、待办只收你确认过的，
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
