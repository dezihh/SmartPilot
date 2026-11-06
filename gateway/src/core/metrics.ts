// Minimaler Metrik-Registry im Prometheus-Textformat. Kein Client-Paket:
// Es gibt nur Zaehler und Gauges, die das Gateway selbst pflegt (HTTP-Status
// je Route, Prozess-Kennzahlen). Wer mehr braucht, haengt einen Exporter an.
type MetricType = 'counter' | 'gauge';

interface Sample {
  labels: Record<string, string>;
  value: number;
}

interface Metric {
  help: string;
  type: MetricType;
  samples: Sample[];
}

const registry = new Map<string, Metric>();
// Begrenzung gegen unbegrenztes Wachstum durch dynamische Labels (z. B.
// Pfade mit IDs): oberhalb des Limits wird ein Sammel-Label verwendet.
const MAX_SAMPLES = 200;

function metricFor(name: string, help: string, type: MetricType): Metric {
  let m = registry.get(name);
  if (!m) {
    m = { help, type, samples: [] };
    registry.set(name, m);
  }
  return m;
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function addSample(name: string, help: string, type: MetricType, labels: Record<string, string>, delta: number): void {
  const m = metricFor(name, help, type);
  const existing = m.samples.find((s) => sameLabels(s.labels, labels));
  if (existing) {
    existing.value = type === 'counter' ? existing.value + delta : delta;
    return;
  }
  if (m.samples.length >= MAX_SAMPLES) {
    const overflow = m.samples.find((s) => s.labels.other === 'true');
    if (overflow) {
      overflow.value += delta;
    } else {
      m.samples.push({ labels: { other: 'true' }, value: delta });
    }
    return;
  }
  m.samples.push({ labels, value: delta });
}

export function incCounter(name: string, labels: Record<string, string> = {}, help = name, value = 1): void {
  addSample(name, help, 'counter', labels, value);
}

export function setGauge(name: string, value: number, labels: Record<string, string> = {}, help = name): void {
  addSample(name, help, 'gauge', labels, value);
}

// Registry leeren (Neustart, Tests). Kein Test-Hook-Suffix: die Funktion
// beschreibt eine gueltige Operation der Registry selbst.
export function resetMetrics(): void {
  registry.clear();
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  const body = entries.map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
  return `{${body}}`;
}

// Prometheus-Textformat (Version 0.0.4): HELP/TYPE je Metrik, danach Samples.
export function renderMetrics(): string {
  const names = [...registry.keys()].sort();
  const out: string[] = [];
  for (const name of names) {
    const m = registry.get(name)!;
    out.push(`# HELP ${name} ${m.help}`);
    out.push(`# TYPE ${name} ${m.type}`);
    for (const sample of m.samples) {
      out.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
