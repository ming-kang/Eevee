import type { RoleName } from "./domain.ts";

/**
 * Why the Engine refused a request, as data: the panel words it in the reader's language, and
 * `describeProblem` gives the Engine's own words for the CLI, its log and the model. Words that are
 * someone else's (a thrown error nobody expected) travel verbatim as `internal`'s `detail`.
 */
export type Problem =
  | { code: "unauthorized" }
  | { code: "bad_code" }
  | { code: "forbidden_host" }
  | { code: "no_route"; method: string; path: string }
  | { code: "no_file" }
  | { code: "bad_json" }
  | { code: "too_large" }
  | { code: "required"; field: string }
  | { code: "invalid"; field: string; allowed?: readonly string[] }
  | { code: "no_project"; projectId: string }
  | { code: "no_ticket"; ticketId: string }
  | { code: "no_worker"; ticketId: string }
  | { code: "no_question"; questionId: string }
  | { code: "no_job"; jobId: string }
  | { code: "no_memory_file"; file: string }
  | { code: "no_commit"; commit: string }
  | { code: "no_model"; provider: string; modelId: string }
  | { code: "no_provider"; provider: string }
  | { code: "no_extension"; names: readonly string[] }
  | { code: "model_unset"; role: RoleName }
  | { code: "ticket_closed"; ticketId: string }
  | { code: "report_changed"; ticketId: string }
  | { code: "answered"; questionId: string }
  | { code: "job_ended"; jobId: string }
  | { code: "running" }
  | { code: "not_failed" }
  | { code: "revert_failed"; commit: string }
  | { code: "bad_config"; problems: readonly ConfigProblem[] }
  | { code: "model_in_use"; provider: string; modelId: string }
  | { code: "probe_failed"; detail: string }
  | { code: "internal"; detail: string };

export type ProblemCode = Problem["code"];

/** An error carrying a Problem; its message is the Engine's wording. */
export class ProblemError extends Error {
  override name = "ProblemError";
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(describeProblem(problem));
    this.problem = problem;
  }
}

/** The Problem behind any thrown value; one the Engine didn't anticipate is `internal`. */
export function problemOf(error: unknown): Problem {
  if (error instanceof ProblemError) return error.problem;
  return { code: "internal", detail: error instanceof Error ? error.message : String(error) };
}

export function describeProblem(problem: Problem): string {
  switch (problem.code) {
    case "unauthorized":
      return "需要授权，请运行 eevee 打开面板";
    case "bad_code":
      return "授权码无效或已过期，请重新运行 eevee";
    case "forbidden_host":
      return "只接受本机请求";
    case "no_route":
      return `没有接口 ${problem.method} ${problem.path}`;
    case "no_file":
      return "没有这个文件";
    case "bad_json":
      return "请求体不是合法的 JSON";
    case "too_large":
      return "请求体过大";
    case "required":
      return `${problem.field} 不能为空`;
    case "invalid":
      return problem.allowed === undefined
        ? `${problem.field} 不合法`
        : `${problem.field} 只能是 ${problem.allowed.join(" / ")}`;
    case "no_project":
      return `没有项目 ${problem.projectId}`;
    case "no_ticket":
      return `没有工单 ${problem.ticketId}`;
    case "no_worker":
      return `找不到 ${problem.ticketId} 的执行对话`;
    case "no_question":
      return `没有问题 ${problem.questionId}`;
    case "no_job":
      return `没有作业 ${problem.jobId}`;
    case "no_memory_file":
      return `没有记忆文件 ${problem.file}`;
    case "no_commit":
      return `没有 commit ${problem.commit}`;
    case "no_model":
      return `没有模型 ${problem.provider}/${problem.modelId}`;
    case "no_provider":
      return `没有 provider ${problem.provider}`;
    case "no_extension":
      return `没有安装扩展：${problem.names.join("、")}`;
    case "model_unset":
      return `${problem.role} 没有可用的模型：在 settings.json 的 models 里设置 default 或 ${problem.role}，或建单时指定 provider 与 modelId。`;
    case "ticket_closed":
      return `${problem.ticketId} 已经结单`;
    case "report_changed":
      return `${problem.ticketId} 待验收的报告已经变了，请先看最新一报`;
    case "answered":
      return `${problem.questionId} 已经回答过了`;
    case "job_ended":
      return `作业 ${problem.jobId} 已经结束`;
    case "running":
      return "对话正在运行";
    case "not_failed":
      return "上一轮没有失败，不需要重试";
    case "revert_failed":
      return `撤销 ${problem.commit} 失败：没有这个 commit，或后来的改动（含还没提交的）与它冲突。`;
    case "bad_config":
      return problem.problems.map(describeConfigProblem).join("\n");
    case "model_in_use":
      return `${problem.provider}/${problem.modelId} 正被默认模型使用，先换掉再改`;
    case "probe_failed":
      return `获取模型列表失败：${problem.detail}`;
    case "internal":
      return problem.detail;
  }
}

/**
 * What is wrong with a file the user edits, or with something loaded from it. Eevee skips what it names
 * and loads the rest; a validator's or a library's own words travel verbatim as `detail`.
 */
export type ConfigIssue =
  | { code: "schema"; path: string; detail: string }
  | { code: "shape"; expected: string }
  | { code: "invalid"; field: string; allowed?: readonly string[] }
  | { code: "needs_models" }
  | { code: "unsupported_api"; model: string; api: string }
  | { code: "needs_api"; model: string }
  | { code: "needs_base_url"; model: string }
  | { code: "no_auth" }
  | { code: "env_unset"; name: string }
  | { code: "name_taken"; name: string }
  | { code: "name_reserved"; name: string }
  | { code: "bad_export" }
  | { code: "disconnected" }
  | { code: "failed"; detail: string };

/** A ConfigIssue and where it is: the file, and the provider, server or path inside it. */
export type ConfigProblem = ConfigIssue & { file: string; entry?: string };

export function describeConfigIssue(issue: ConfigIssue): string {
  switch (issue.code) {
    case "schema":
      return `${issue.path}：${issue.detail}`;
    case "shape":
      return `应为 ${issue.expected}`;
    case "invalid":
      return issue.allowed === undefined
        ? `${issue.field} 不合法`
        : `${issue.field} 应为 ${issue.allowed.join(" / ")}`;
    case "needs_models":
      return "新增的 provider 需要 models";
    case "unsupported_api":
      return `模型 ${issue.model} 的 api「${issue.api}」不受支持`;
    case "needs_api":
      return `模型 ${issue.model} 没有指定 api`;
    case "needs_base_url":
      return `模型 ${issue.model} 没有 baseUrl`;
    case "no_auth":
      return "没有可用的认证方式";
    case "env_unset":
      return `${issue.name} 引用的环境变量没有设置`;
    case "name_taken":
      return `扩展名 ${issue.name} 已被另一个文件使用`;
    case "name_reserved":
      return `扩展名 ${issue.name} 是 Eevee 保留的`;
    case "bad_export":
      return "默认导出应为 extension（带 name 的对象），或返回 extension 的函数";
    case "disconnected":
      return "连接已断开";
    case "failed":
      return issue.detail;
  }
}

export function describeConfigProblem(problem: ConfigProblem): string {
  const where = problem.entry === undefined ? problem.file : `${problem.file} 的 ${problem.entry}`;
  return `${where}：${describeConfigIssue(problem)}`;
}
