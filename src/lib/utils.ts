import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 把平台网关截断（60 秒超时返回空响应）等技术报错翻译成用户可操作的提示 */
export function friendlyApiError(msg: string): string {
  if (/Unexpected end of JSON|Failed to execute 'json'|524/i.test(msg)) {
    return "请求超时：平台限制单次请求 60 秒内返回，本次生成内容较多被截断。请直接重试；若反复出现，可减少配图种类或缩短素材";
  }
  return msg;
}
