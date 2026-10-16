import { useState } from 'react';
import { PerformanceBenchmark } from './PerformanceBenchmark';
import { GraphView } from './GraphView';
import { createIdleRotationClock } from './graph-rotation';
import { ThemePreviewProvider } from './ThemeProvider';
import './performance-benchmark.css';

/** This route mounts before AuthGate and never requests private knowledge. */
export default function PerformancePage() {
  const [rotationClock] = useState(createIdleRotationClock);
  return <PerformanceBenchmark renderGraph={(props) => <ThemePreviewProvider theme={props.theme}>
    <GraphView snapshot={props.snapshot} layout={props.layout} selectedId={props.selectedId} simulated paused={props.paused}
      twoDimensional={props.twoDimensional} glowEnabled={props.glowEnabled} renderQuality={props.renderQuality}
      autoRotateEnabled={false} rotationClock={rotationClock} onSelect={props.onSelect} onLayoutChange={props.onLayoutChange}
      onPerformanceProbeReady={props.onProbeReady} />
  </ThemePreviewProvider>} />;
}
