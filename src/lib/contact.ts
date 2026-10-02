/**
 * 对外联系方式的单一事实源。
 *
 * 此前 WhatsApp 号码以字面量散落在 Navbar / Footer / 产品页三处，Contact 页又从
 * Sanity 读第四份——改一次号要动四个地方，漏掉任何一处就会出现站内号码不一致。
 * 这里收敛成一处，所有组件一律引用本文件。
 */

/** E.164 格式（带 +），用于 tel: 链接与对外展示。 */
export const PHONE_E164 = '+8618872711490';

/** 展示用写法，分段后更易读。 */
export const PHONE_DISPLAY = '+86 188 7271 1490';

/**
 * wa.me 只接受纯数字：带 + 号或空格会被 WhatsApp 判为无效号码，打不开会话。
 * 因此这里先剥掉所有非数字字符再拼接，得到 8618872711490。
 */
export const WHATSAPP_URL = `https://wa.me/${PHONE_E164.replace(/\D/g, '')}`;
