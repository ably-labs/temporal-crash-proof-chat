// What GET /api/config returns.

export interface DemoConfig {
  channelPrefix: string;
  endpoint: string | null;
  model: string;
  poolSize: number;
  workers: string[];
  temporalUiUrl: string;
  namespace: string;
  taskQueue: string;
}
