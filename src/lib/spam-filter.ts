/**
 * 第一道与第四道防线：蜜罐 + 语义特征。
 *
 * 设计原则是「零误杀」：只拦确定的垃圾，模糊的一律放行并交给业务员判断。
 */

/**
 * 高阶蜜罐字段名。
 *
 * 命名刻意避开 `website` / `url` 这类会被浏览器全局自动填充和密码管理器主动填写的名字：
 * 真人被自动填充误伤 = 直接丢单，这在「零误杀」的业务底线前不可接受。
 * 改用表单里看起来完全合理、而自动填充不会碰的字段。
 *
 * 前端**不使用** display:none / opacity:0——那类属性容易被爬虫识别为陷阱。
 */
export const HONEYPOT_FIELDS = ['company_fax', 'skype_id_optional'] as const;

/**
 * 返回所有被填了值的蜜罐字段。
 *
 * 刻意返回明细而非布尔值：蜜罐是「静默丢弃 + 伪装成功」的，一旦误判，
 * 用户看到的是发送成功、邮箱里却什么都没有——日志是事后唯一的取证途径，
 * 必须记下是哪个字段、内容是什么。
 */
export function findHoneypotHits(
  payload: Record<string, unknown>,
): Array<{ field: string; value: string }> {
  const hits: Array<{ field: string; value: string }> = [];

  for (const field of HONEYPOT_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) hits.push({ field, value: text.slice(0, 64) });
  }

  return hits;
}

/**
 * 确定的 B2B 推销黑名单。命中即静默丢弃。
 *
 * 列表刻意收窄——这里出现的每个词，在皮具/箱包 OEM 的真实询盘里都不可能出现。
 * 宁可漏放几条推销邮件，也不能误杀一单真实生意。
 */
const BLACKLIST_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'guest-post', re: /\bguest\s?posts?\b/i },
  { label: 'seo-ranking', re: /\bseo\s+(?:ranking|rankings|services?|packages?|agency|expert)\b/i },
  { label: 'link-building', re: /\b(?:back\s?links?|link\s?building)\b/i },
  { label: 'domain-authority', re: /\b(?:domain\s+authority|DA\s?\d{2})\b/i },
  { label: 'search-ranking', re: /\b(?:rank(?:ing)?\s+(?:higher|on\s+google)|first\s+page\s+of\s+google)\b/i },
  { label: 'bulk-marketing', re: /\b(?:bulk\s+(?:email|sms)|email\s+list\s+for\s+sale|lead\s+generation\s+services?)\b/i },
  { label: 'casino-crypto', re: /\b(?:online\s+casino|crypto\s+investment|forex\s+signals?|binary\s+options?)\b/i },
];

/** 返回命中的黑名单标签，未命中返回 null。 */
export function matchBlacklist(text: string): string | null {
  for (const { label, re } of BLACKLIST_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** 正文含 HTTP 链接 / 裸域名 www. */
export function containsLink(text: string): boolean {
  return /(?:https?:\/\/|www\.)\S/i.test(text);
}

/** 正文含西里尔字母（俄语 / 独联体） */
export function containsCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

/** 软标记结果——只影响邮件标题前缀，不影响投递与否。 */
export function buildSubjectTags(text: string): string[] {
  const tags: string[] = [];
  if (containsLink(text)) tags.push('[Has Links]');
  if (containsCyrillic(text)) tags.push('[RU/CIS]');
  return tags;
}
