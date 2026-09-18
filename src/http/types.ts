export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  headers: Headers;
  data: T;
  rawText: string;
}
