export interface GraphNode {
  id: string;
  label: string;
  val: number; // Size/Importance
  group?: number;
  x?: number; // D3 coord
  y?: number; // D3 coord
}

export interface GraphLink {
  source: string | GraphNode; // ID or Node object after d3 binds it
  target: string | GraphNode;
  value: number; // Thickness/Strength
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export enum SessionStatus {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  ACTIVE = 'active',
  ERROR = 'error',
}

export interface SessionRecord {
  id: string;
  timestamp: number;
  transcript: string;
  graphData: GraphData;
}

export type VisMode = 'network' | 'stream' | 'layers' | 'cluster';

export interface HandCursor {
  x: number; // 0-1 relative to screen width
  y: number; // 0-1 relative to screen height
  isPinching: boolean; // True if Index + Thumb are close
}