/**
 * JSON Schema 校验（第 6 章）
 *
 * 在工具 dispatch 之前进行参数 shape 校验。
 * 返回错误列表而非抛异常——模型从"一条消息列出三件事"学得比
 * "连续 3 个回合各修一个"快得多（Reflexion 效应，Shinn et al. 2023）。
 */
import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/* ─── ValidationError ────────────────────────────────────────────── */

/**
 * 结构化的校验错误。
 *
 * 与 Python 版 @dataclass(frozen=True) 对应：
 *   - message: 人类可读的错误描述
 *   - path: JSON-pointer-ish 路径，如 "args.expression"
 */
export class ValidationError {
  constructor(
    readonly message: string,
    readonly path: string,
  ) {}

  toString(): string {
    return `${this.path}: ${this.message}`;
  }
}

/* ─── validate ───────────────────────────────────────────────────── */

/**
 * 校验参数是否符合 JSON Schema。
 *
 * @param args   - 要校验的参数对象
 * @param schema - JSON Schema（inputSchema）
 * @returns 错误列表。空数组 = 校验通过。
 */
export function validate(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationError[] {
  const validator = ajv.compile(schema);
  const valid = validator(args);

  if (valid) return [];

  return (validator.errors ?? []).map(toValidationError);
}

/* ─── 辅助 ────────────────────────────────────────────────────────── */

/**
 * 将 ajv 的 ErrorObject 转换为我们的 ValidationError。
 *
 * absolutePath 是一个整型/字符串路径片段数组，如 ['expression']
 * 或 ['items', 0, 'name']。我们渲染成人类可读的 "args.expression"
 * 或 "args.items[0].name"。
 */
function toValidationError(err: ErrorObject): ValidationError {
  const path = "args" + formatPath(err.instancePath ?? "");
  const message = err.message ?? "invalid value";
  return new ValidationError(message, path);
}

/**
 * 将 JSON Pointer 路径（如 "/expression"）格式化为点号路径
 * （如 ".expression"），方便拼接。
 *
 * "/expression"         → ".expression"
 * "/items/0/name"       → ".items[0].name"
 * "" (根路径)            → ""
 */
function formatPath(instancePath: string): string {
  if (!instancePath) return "";

  const parts = instancePath.split("/").filter(Boolean);
  const formatted = parts.map((part) => {
    const num = Number(part);
    return Number.isInteger(num) ? `[${num}]` : `.${part}`;
  });
  return formatted.join("");
}
