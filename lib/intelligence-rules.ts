export type SignalName =
  | 'mention_me'
  | 'urgency'
  | 'negative_emotion'
  | 'conflict'
  | 'issue'
  | 'needs_response'
  | 'resolution';

export interface MessageSignalResult {
  signals: SignalName[];
  candidate_reasons: string[];
}

export interface WorkGroupResult {
  likely_work_group: boolean;
  work_score: number;
  reasons: string[];
}

const URGENCY_RE =
  /紧急|非常急|十万火急|马上|立刻|立即|尽快|今天必须|务必今天|加急|asap|影响上线|线上事故|生产事故|客户投诉/iu;
const NEGATIVE_EMOTION_RE =
  /无法接受|不能接受|太离谱|很失望|非常失望|愤怒|生气|投诉|没人管|没人负责|不负责任|敷衍|扯皮|推诿|荒唐|糟糕透了|到底怎么回事|什么意思[？?!！!]/u;
const CONFLICT_RE =
  /甩锅|推诿|争执|冲突|吵|别再|谁的责任|责任在谁|你们到底|相互指责|不配合|拒绝配合|请解释清楚/u;
const ISSUE_RE =
  /问题|异常|故障|报错|错误|失败|无法|不能用|卡住|阻塞|延期|延误|投诉|风险|事故|掉线|崩溃|未解决|没解决|尚未解决/u;
const RESPONSE_RE =
  /[？?]|请问|能否|可以.*吗|麻烦|请.*回复|请.*反馈|谁来|什么时候|有没有人|求回复|帮忙看|确认一下|跟进一下/u;
const RESOLUTION_RE =
  /已解决|解决了|已修复|修好了|已恢复|处理完成|已经处理|搞定|结论是|方案是|已回复|已反馈|已跟进|已确认/u;
const WORK_NAME_RE =
  /项目|工作|客户|品牌|交付|运营|产品|研发|市场|商务|销售|售后|供应商|合作|campaign|brief|agency|复盘|周报|日报|战报|需求|发布|上线|制作|媒介|公关|设计/iu;
const WORK_CONTENT_RE =
  /客户|交付|方案|需求|排期|进度|报价|合同|预算|上线|发布|验收|反馈|会议|工单|版本|负责人|截止|deadline|brief|复盘|审批|发票/iu;
const CASUAL_NAME_RE =
  /家人|家庭|亲友|同学|校友|吃喝|饭搭子|麻将|游戏|闲聊|吹水|旅游|旅行|小区邻居|兴趣|读书会|拼车/iu;

export function classifyMessageSignals(
  content: string,
  myNicknames: string[],
): MessageSignalResult {
  const normalized = content.trim();
  const signals: SignalName[] = [];
  const candidateReasons: string[] = [];

  if (mentionsConfiguredName(normalized, myNicknames)) {
    signals.push('mention_me');
    candidateReasons.push('明确 @ 到本人别名');
  }
  if (URGENCY_RE.test(normalized)) {
    signals.push('urgency');
    candidateReasons.push('出现明确紧急措辞');
  }
  if (NEGATIVE_EMOTION_RE.test(normalized)) {
    signals.push('negative_emotion');
    candidateReasons.push('出现强烈负面情绪措辞');
  }
  if (CONFLICT_RE.test(normalized)) {
    signals.push('conflict');
    candidateReasons.push('出现冲突或相互指责措辞');
  }
  if (ISSUE_RE.test(normalized)) {
    signals.push('issue');
    candidateReasons.push('出现问题或风险措辞');
  }
  if (RESPONSE_RE.test(normalized)) {
    signals.push('needs_response');
    candidateReasons.push('可能需要明确回复');
  }
  if (RESOLUTION_RE.test(normalized)) {
    signals.push('resolution');
    candidateReasons.push('出现解决或闭环措辞');
  }

  return { signals, candidate_reasons: candidateReasons };
}

export function classifyWorkGroup(
  groupName: string,
  recentContents: string[],
): WorkGroupResult {
  const sample = recentContents.slice(-80).join('\n');
  const reasons: string[] = [];
  let rawScore = 0;

  if (WORK_NAME_RE.test(groupName)) {
    rawScore += 3;
    reasons.push('群名包含工作或项目词');
  }
  if (WORK_CONTENT_RE.test(sample)) {
    rawScore += 2;
    reasons.push('近期消息包含交付、需求或进度语境');
  }
  if (ISSUE_RE.test(sample) || URGENCY_RE.test(sample)) {
    rawScore += 1;
    reasons.push('近期存在问题或紧急语境');
  }
  if (CASUAL_NAME_RE.test(groupName)) {
    rawScore -= 4;
    reasons.push('群名更接近生活或闲聊场景');
  }

  const workScore = Math.max(0, Math.min(1, (rawScore + 1) / 6));
  return {
    likely_work_group: rawScore >= 2,
    work_score: Number(workScore.toFixed(2)),
    reasons,
  };
}

function mentionsConfiguredName(content: string, names: string[]) {
  return names.some((rawName) => {
    const name = rawName.trim();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`[@＠]\\s*${escaped}(?=\\s|$|[，,。.!！?？:：])`, 'iu').test(
      content,
    );
  });
}
