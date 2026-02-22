export type Result<T, K extends string = string> =
  | ({ ok: true } & T)
  | { ok: false; kind: K; message: string };
