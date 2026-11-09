/**
 * 这个扩展服务的 sdpppx 部署事实。
 *
 * 这些值属于「插件就是为这个部署而构建」的固定身份，不通过环境变量注入：改租户或改
 * 部署环境需要改这里并重新构建扩展。Supabase anon key 是公开客户端密钥，不是
 * service_role；仍然不得把 service_role key、Authing token 或用户令牌带进这里。
 *
 * 可调的运行参数（登录提示、bridge 覆盖、模板类型映射等）仍由 `config.ts` 从环境变量读取。
 */

export type SdpppxDeployment = {
  /** 租户 UUID：bridge、模板目录与上传头。 */
  tenantId: string;
  /** Supabase 网关或项目 URL，例如 https://<project>.supabase.co。 */
  supabaseUrl: string;
  /** Supabase 公开 anon key；只用于 apikey 与匿名读取租户表。 */
  supabaseAnonKey: string;
};

export const SDPPPX_DEPLOYMENT: SdpppxDeployment = {
  tenantId: "65b95867-1c57-42ed-baa5-849a89790b51",
  supabaseUrl: "https://sdpppx.zombee.tech/supabase/scehmsoyamzjjwzbnqxu",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjZWhtc295YW16amp3emJucXh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxOTYxMjMsImV4cCI6MjA4Mjc3MjEyM30.Lt7x-Xrx8M8t7ytuN_8AGtVzvYm_aGOyLKRaew0rLvs"
};
