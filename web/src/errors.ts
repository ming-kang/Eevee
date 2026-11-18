import { ApiRequestError } from "../../src/api/client.ts";
import type { ConfigIssue, ConfigProblem, Problem } from "../../src/contracts/index.ts";
import { t } from "./i18n.ts";
import { ROLE_LABEL } from "./labels.ts";
import { StreamError } from "./stream.ts";

const list = (items: readonly string[]): string => items.join(t("、"));

/** Why the Engine refused, in the reader's words. Only an unforeseen error shows its own text. */
export function problemText(problem: Problem): string {
  switch (problem.code) {
    case "unauthorized":
      return t("需要授权，请用 eevee web 打开面板");
    case "bad_code":
      return t("授权码无效或已过期，请重新运行 eevee web");
    case "forbidden_host":
      return t("只接受本机请求");
    case "cli_only":
      return t("只允许 CLI 调用");
    case "no_route":
      return t("没有接口 {method} {path}", problem);
    case "no_file":
      return t("没有这个文件");
    case "bad_json":
      return t("请求体不是合法的 JSON");
    case "too_large":
      return t("请求体过大");
    case "required":
      return t("{field} 不能为空", problem);
    case "invalid":
      return problem.allowed === undefined
        ? t("{field} 不合法", { field: problem.field })
        : t("{field} 只能是 {allowed}", {
            field: problem.field,
            allowed: problem.allowed.join(" / "),
          });
    case "no_project":
      return t("找不到这个项目");
    case "no_ticket":
      return t("没有工单 {ticketId}", problem);
    case "no_worker":
      return t("找不到 {ticketId} 的执行对话", problem);
    case "no_question":
      return t("没有问题 {questionId}", problem);
    case "no_job":
      return t("没有作业 {jobId}", problem);
    case "no_memory_file":
      return t("没有记忆文件 {file}", problem);
    case "no_commit":
      return t("没有 commit {commit}", problem);
    case "no_model":
      return t("没有模型 {provider}/{modelId}", problem);
    case "no_provider":
      return t("没有 Provider {provider}", problem);
    case "no_extension":
      return t("没有安装扩展：{names}", { names: list(problem.names) });
    case "model_unset":
      return t("{role} 没有可用的模型", { role: ROLE_LABEL[problem.role] });
    case "ticket_closed":
      return t("{ticketId} 已经结单", problem);
    case "report_changed":
      return t("{ticketId} 待验收的报告已经变了，请先看最新一报", problem);
    case "answered":
      return t("{questionId} 已经回答过了", problem);
    case "job_ended":
      return t("作业 {jobId} 已经结束", problem);
    case "running":
      return t("对话正在运行");
    case "not_failed":
      return t("上一轮没有失败，不需要重试");
    case "revert_failed":
      return t("撤销 {commit} 失败：没有这个 commit，或与后来的改动冲突", problem);
    case "internal":
      return problem.detail;
  }
}

/** What is wrong with a config file or something loaded from it, in the reader's words. */
export function configIssueText(issue: ConfigIssue): string {
  switch (issue.code) {
    case "schema":
      return t("{label}：{detail}", { label: issue.path, detail: issue.detail });
    case "shape":
      return t("格式应为 {expected}", issue);
    case "invalid":
      return issue.allowed === undefined
        ? t("{field} 不合法", { field: issue.field })
        : t("{field} 只能是 {allowed}", { field: issue.field, allowed: issue.allowed.join(" / ") });
    case "needs_models":
      return t("新增的 Provider 需要 models");
    case "unsupported_api":
      return t("模型 {model} 的 api「{api}」不受支持", issue);
    case "needs_api":
      return t("模型 {model} 没有指定 api", issue);
    case "needs_base_url":
      return t("模型 {model} 没有 baseUrl", issue);
    case "no_auth":
      return t("没有可用的认证方式");
    case "env_unset":
      return t("{name} 引用的环境变量没有设置", issue);
    case "name_taken":
      return t("扩展名 {name} 已被另一个文件使用", issue);
    case "name_reserved":
      return t("扩展名 {name} 是 Eevee 保留的", issue);
    case "bad_export":
      return t("默认导出应为 extension，或返回 extension 的函数");
    case "disconnected":
      return t("连接已断开");
    case "failed":
      return issue.detail;
  }
}

/** A config problem under a heading that already names its file: the entry, then what is wrong. */
export function configProblemText(problem: ConfigProblem): string {
  const issue = configIssueText(problem);
  return problem.entry === undefined
    ? issue
    : t("{label}：{detail}", { label: problem.entry, detail: issue });
}

/** What to show for anything a call threw: a refusal in the reader's words, else the error's text. */
export function errorText(cause: unknown): string {
  if (cause instanceof ApiRequestError || cause instanceof StreamError) {
    return problemText(cause.problem);
  }
  return cause instanceof Error ? cause.message : String(cause);
}
