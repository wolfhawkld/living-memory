import type { GraphRenderQuality } from './graph-render-quality.js';

export interface GraphQualityControlProps {
  quality: GraphRenderQuality;
  disabled: boolean;
  onChange: (quality: GraphRenderQuality) => void;
}

const GRAPH_QUALITY_ID = 'living-memory-graph-render-quality';

export function GraphQualityControl({ quality, disabled, onChange }: GraphQualityControlProps) {
  return (
    <div className="graph-quality-control">
      <label className="domain-picker-label graph-quality-label" htmlFor={GRAPH_QUALITY_ID}>
        渲染清晰度
      </label>
      <select
        id={GRAPH_QUALITY_ID}
        className="tool-button domain-picker-select graph-quality-select"
        value={quality}
        disabled={disabled}
        title="较低档降低高分屏画布分辨率，不减少文字标签、节点或关系数量；光效单独设置。"
        onChange={(event) => {
          if (disabled) return;
          const value = event.currentTarget.value;
          if (value === 'standard' || value === 'low') onChange(value);
        }}
      >
        <option value="standard">默认</option>
        <option value="low">较低</option>
      </select>
    </div>
  );
}
