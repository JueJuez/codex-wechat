// @ts-check
import { uploadFile, sendFile } from '../vendor/wechat-core/lib/index.js';

/**
 * @param {{account: import('../vendor/wechat-core/lib/index.js').WeixinAccount, to: string, path: string, contextToken?: string}} params
 */
export async function sendFilePath({ account, to, path, contextToken }) {
  const uploaded = await uploadFile({ account, toUserId: to, path });
  return await sendFile({ account, to, uploaded, contextToken });
}
