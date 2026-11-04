import * as THREE from "three";
import type { VoiceMemoryGraph } from "../voiceMemoryGraph";
import type { SynapseScheduler } from "./synapseBolts";

const STATUS_COLOR: Record<string, string> = {
  approved: "#34d399",
  candidate: "#fbbf24",
  rejected: "#f87171",
  error: "#f87171",
  folder: "#a78bfa",
};
const ROOT_COLOR = "#fcd34d";
const NOTE_COLOR = "#60a5fa";
const CURVE_SEGMENTS = 12;
const BOLT_SEGMENTS = 14;
const FOV = 45;
/** One full clockwise turn (seen from above) every ~2.5 minutes. */
const SPIN_SPEED = (Math.PI * 2) / 150;

const DEPTH_GLSL = /* glsl */ `
  varying float vFade;
  // Notes behind the graph centre fade into the dark instead of competing with the front.
  float depthFade(float viewDepth, float distance) { return clamp(1.25 - (viewDepth - distance + 0.4) * 0.45, 0.18, 1.0); }
`;

const NODE_VERTEX = /* glsl */ `
  ${DEPTH_GLSL}
  uniform float uPixelsPerUnit, uDistance, uTime;
  attribute vec3 aColor;
  attribute float aSize, aFlash, aPhase;
  varying vec3 vColor;
  varying float vFlash;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float breathe = 1.0 + sin(uTime * 0.9 + aPhase) * 0.06;
    gl_PointSize = aSize * breathe * (1.0 + aFlash * 0.9) * uPixelsPerUnit / -mv.z;
    vFade = depthFade(-mv.z, uDistance);
    vColor = aColor;
    vFlash = aFlash;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  uniform float uDim;
  varying vec3 vColor;
  varying float vFade;
  varying float vFlash;
  void main() {
    float r = length(gl_PointCoord * 2.0 - 1.0);
    if (r > 1.0) discard;
    float core = smoothstep(0.32, 0.12, r);
    float glow = exp(-r * r * 7.0) * 0.55;
    vec3 color = mix(vColor, vec3(1.0), core * 0.55 + vFlash * 0.5);
    gl_FragColor = vec4(color, (core + glow) * vFade * uDim * (0.75 + vFlash * 0.6));
  }
`;

const EDGE_VERTEX = /* glsl */ `
  ${DEPTH_GLSL}
  uniform float uDistance;
  attribute float aT, aDirect;
  varying float vT, vDirect;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vFade = depthFade(-mv.z, uDistance);
    vT = aT;
    vDirect = aDirect;
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  uniform float uDim, uEnergy;
  varying float vFade;
  varying float vT, vDirect;
  void main() {
    vec3 color = mix(vec3(0.51, 0.55, 0.97), vec3(0.49, 0.83, 0.99), vT);
    float alpha = mix(0.24, 0.42, vDirect) * (1.0 + uEnergy * 0.6);
    gl_FragColor = vec4(color, alpha * vFade * uDim);
  }
`;

const BOLT_VERTEX = /* glsl */ `
  ${DEPTH_GLSL}
  uniform float uPixelsPerUnit, uDistance;
  attribute float aAlpha, aSize;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelsPerUnit / -mv.z;
    vFade = depthFade(-mv.z, uDistance);
    vAlpha = aAlpha;
  }
`;

const BOLT_LINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vFade;
  void main() { gl_FragColor = vec4(uColor, vAlpha * (0.45 + vFade * 0.55)); }
`;

const BOLT_GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vFade;
  void main() {
    float r = length(gl_PointCoord * 2.0 - 1.0);
    if (r > 1.0) discard;
    float glow = exp(-r * r * 5.0);
    gl_FragColor = vec4(mix(uColor, vec3(1.0), glow * 0.5), glow * vAlpha * (0.45 + vFade * 0.55));
  }
`;

/** Deterministic hash so a bolt's zigzag only changes when its flicker frame does. */
function hash(a: number, b: number, c: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

export interface ProjectedNode {
  index: number;
  x: number;
  y: number;
  /** View depth relative to the graph centre: < 0 is in front. */
  depth: number;
}

/**
 * The LLM wiki as a slowly turning 3D network behind the whole voice tab. Nodes are
 * glowing sprites coloured by review status, links are gently bowed curves, and the
 * discharges of a SynapseScheduler are drawn as flickering lightning (jagged core line
 * plus glow beads) racing along those curves.
 */
export class MemoryBackdrop {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  private readonly tilt = new THREE.Group();
  private readonly spin = new THREE.Group();
  private readonly dust: THREE.Points;
  private readonly common = { uDim: { value: 1 }, uDistance: { value: 4 }, uPixelsPerUnit: { value: 500 }, uTime: { value: 0 }, uEnergy: { value: 0 } };
  private graph: VoiceMemoryGraph | null = null;
  private nodes: THREE.Points | null = null;
  private edges: THREE.LineSegments | null = null;
  private flashAttribute: THREE.BufferAttribute | null = null;
  /** Per edge: p0, control, p1 (9 floats) - shared by edge geometry and bolts. */
  private curves = new Float32Array(0);
  private readonly boltLines: THREE.LineSegments;
  private readonly boltGlow: THREE.Points;
  private readonly boltCapacity: number;
  private readonly tmp = new THREE.Vector3();

  constructor(maxDischarges: number) {
    this.camera.position.set(0, 0, 4);
    this.tilt.rotation.x = 0.48;
    this.tilt.add(this.spin);
    this.scene.add(this.tilt);
    this.dust = this.createDust();
    this.scene.add(this.dust);

    this.boltCapacity = maxDischarges;
    const lineVertices = maxDischarges * BOLT_SEGMENTS * 2;
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lineVertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(lineVertices), 1).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(lineVertices), 1));
    this.boltLines = new THREE.LineSegments(lineGeometry, this.material(BOLT_VERTEX, BOLT_LINE_FRAGMENT, { uColor: { value: new THREE.Color("#e0f2fe") } }));
    const glowPoints = maxDischarges * (BOLT_SEGMENTS + 2);
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(glowPoints * 3), 3).setUsage(THREE.DynamicDrawUsage));
    glowGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(glowPoints), 1).setUsage(THREE.DynamicDrawUsage));
    glowGeometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(glowPoints), 1).setUsage(THREE.DynamicDrawUsage));
    this.boltGlow = new THREE.Points(glowGeometry, this.material(BOLT_VERTEX, BOLT_GLOW_FRAGMENT, { uColor: { value: new THREE.Color("#818cf8") } }));
    for (const object of [this.boltLines, this.boltGlow]) {
      object.frustumCulled = false;
      object.renderOrder = 3;
      this.spin.add(object);
    }
  }

  private material(vertexShader: string, fragmentShader: string, extra: Record<string, THREE.IUniform> = {}) {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.common, ...extra },
      vertexShader, fragmentShader,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }

  private createDust(): THREE.Points {
    const count = 900;
    const positions = new Float32Array(count * 3), alphas = new Float32Array(count), sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, radius = 2.2 + Math.random() * 6;
      const ring = Math.sqrt(1 - u * u);
      positions.set([Math.cos(phi) * ring * radius, u * radius, Math.sin(phi) * ring * radius], i * 3);
      alphas[i] = 0.08 + Math.random() * 0.22;
      sizes[i] = 0.012 + Math.random() * 0.025;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    const dust = new THREE.Points(geometry, this.material(BOLT_VERTEX, BOLT_GLOW_FRAGMENT, { uColor: { value: new THREE.Color("#93c5fd") } }));
    dust.frustumCulled = false;
    dust.renderOrder = -1;
    return dust;
  }

  setGraph(graph: VoiceMemoryGraph | null): void {
    for (const object of [this.nodes, this.edges]) {
      if (!object) continue;
      this.spin.remove(object);
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
    this.nodes = this.edges = this.flashAttribute = null;
    this.graph = graph;
    if (!graph) return;

    const count = graph.nodes.length;
    const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count), phases = new Float32Array(count);
    const color = new THREE.Color();
    const maxDegree = Math.max(1, ...graph.nodes.map((node) => node.degree));
    graph.nodes.forEach((node, i) => {
      positions.set([node.x, node.y, node.z], i * 3);
      const root = i === graph.rootIndex;
      color.set(root ? ROOT_COLOR : STATUS_COLOR[node.kind === "folder" ? "folder" : node.status] ?? NOTE_COLOR);
      colors.set([color.r, color.g, color.b], i * 3);
      sizes[i] = root ? 0.42 : 0.09 + 0.1 * Math.sqrt(node.degree / maxDegree);
      phases[i] = node.phase;
    });
    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    nodeGeometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    nodeGeometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    nodeGeometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    this.flashAttribute = new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    nodeGeometry.setAttribute("aFlash", this.flashAttribute);
    this.nodes = new THREE.Points(nodeGeometry, this.material(NODE_VERTEX, NODE_FRAGMENT));
    this.nodes.renderOrder = 2;

    // Each link bows outward from the graph centre - reads as organic dendrites
    // instead of a straight-line hairball.
    this.curves = new Float32Array(graph.edges.length * 9);
    const edgePositions = new Float32Array(graph.edges.length * CURVE_SEGMENTS * 2 * 3);
    const edgeT = new Float32Array(graph.edges.length * CURVE_SEGMENTS * 2);
    const edgeDirect = new Float32Array(graph.edges.length * CURVE_SEGMENTS * 2);
    const point = new THREE.Vector3();
    graph.edges.forEach((edge, e) => {
      const a = graph.nodes[edge.source]!, b = graph.nodes[edge.target]!;
      const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      const length = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const bow = mid.length() < 1e-3 ? new THREE.Vector3(0, 1, 0) : mid.clone().normalize();
      const control = mid.addScaledVector(bow, length * 0.18);
      this.curves.set([a.x, a.y, a.z, control.x, control.y, control.z, b.x, b.y, b.z], e * 9);
      for (let s = 0; s < CURVE_SEGMENTS; s++) {
        for (let k = 0; k < 2; k++) {
          const t = (s + k) / CURVE_SEGMENTS;
          const v = (e * CURVE_SEGMENTS + s) * 2 + k;
          this.curvePoint(e, t, point);
          edgePositions.set([point.x, point.y, point.z], v * 3);
          edgeT[v] = t;
          edgeDirect[v] = edge.direct ? 1 : 0;
        }
      }
    });
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("aT", new THREE.BufferAttribute(edgeT, 1));
    edgeGeometry.setAttribute("aDirect", new THREE.BufferAttribute(edgeDirect, 1));
    this.edges = new THREE.LineSegments(edgeGeometry, this.material(EDGE_VERTEX, EDGE_FRAGMENT));
    this.edges.renderOrder = 1;
    for (const object of [this.edges, this.nodes]) { object.frustumCulled = false; this.spin.add(object); }
  }

  private curvePoint(edge: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.curves, o = edge * 9, u = 1 - t;
    const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
    return out.set(
      w0 * c[o]! + w1 * c[o + 3]! + w2 * c[o + 6]!,
      w0 * c[o + 1]! + w1 * c[o + 4]! + w2 * c[o + 7]!,
      w0 * c[o + 2]! + w1 * c[o + 5]! + w2 * c[o + 8]!,
    );
  }

  private viewWidth = 1;
  private viewHeight = 1;
  private centreX = 0.5;
  private centreY = 0.5;

  /**
   * Moves the graph centre (index.md) to a screen point, so the network grows out of
   * the orb instead of sitting behind the controls below it. Eased, so scrolling
   * doesn't make the whole network jump.
   */
  focusOn(x: number, y: number): void {
    const tx = THREE.MathUtils.clamp(x / this.viewWidth, 0.2, 0.8), ty = THREE.MathUtils.clamp(y / this.viewHeight, 0.2, 0.8);
    if (Math.abs(tx - this.centreX) < 1e-4 && Math.abs(ty - this.centreY) < 1e-4) return;
    this.centreX += (tx - this.centreX) * 0.15;
    this.centreY += (ty - this.centreY) * 0.15;
    this.camera.setViewOffset(this.viewWidth, this.viewHeight,
      (0.5 - this.centreX) * this.viewWidth, (0.5 - this.centreY) * this.viewHeight, this.viewWidth, this.viewHeight);
  }

  resize(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
    this.camera.setViewOffset(this.viewWidth, this.viewHeight,
      (0.5 - this.centreX) * this.viewWidth, (0.5 - this.centreY) * this.viewHeight, this.viewWidth, this.viewHeight);
    this.camera.aspect = width / Math.max(1, height);
    const halfFov = THREE.MathUtils.degToRad(FOV / 2);
    // The ~1.2 radius graph deliberately overfills the narrower screen axis a little: it is
    // a backdrop spanning the whole tab, not a framed diagram (portrait phones zoom out).
    const distance = THREE.MathUtils.clamp(0.95 / (Math.tan(halfFov) * Math.min(1, this.camera.aspect)), 2.7, 6.5);
    this.camera.position.z = distance;
    this.camera.updateProjectionMatrix();
    this.common.uDistance.value = distance;
  }

  update(seconds: number, reduced: boolean, energy: number, scheduler: SynapseScheduler | null, now: number, heightDevicePx: number): void {
    const t = reduced ? seconds * 0.4 : seconds;
    this.spin.rotation.y = -t * SPIN_SPEED;
    this.tilt.rotation.z = Math.sin(t * 0.05) * 0.04;
    this.dust.rotation.y = -t * SPIN_SPEED * 0.35;
    this.common.uTime.value = t;
    this.common.uEnergy.value = energy;
    this.common.uPixelsPerUnit.value = heightDevicePx / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    if (this.flashAttribute && scheduler) {
      (this.flashAttribute.array as Float32Array).set(scheduler.flash.subarray(0, this.flashAttribute.count));
      this.flashAttribute.needsUpdate = true;
    }
    this.writeDischarges(scheduler, now);
  }

  private writeDischarges(scheduler: SynapseScheduler | null, now: number): void {
    const linePosition = this.boltLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const lineAlpha = this.boltLines.geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
    const glowPosition = this.boltGlow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const glowAlpha = this.boltGlow.geometry.getAttribute("aAlpha") as THREE.BufferAttribute;
    const glowSize = this.boltGlow.geometry.getAttribute("aSize") as THREE.BufferAttribute;
    (lineAlpha.array as Float32Array).fill(0);
    (glowAlpha.array as Float32Array).fill(0);
    const graph = this.graph;
    const path = Array.from({ length: BOLT_SEGMENTS + 1 }, () => new THREE.Vector3());
    const tangent = new THREE.Vector3(), normalA = new THREE.Vector3(), normalB = new THREE.Vector3();
    const discharges = graph && scheduler ? scheduler.discharges.slice(0, this.boltCapacity) : [];
    discharges.forEach((discharge, slot) => {
      const edge = graph!.edges[discharge.edge];
      if (!edge) return;
      const reversed = edge.source !== discharge.from;
      const age = now - discharge.born;
      const head = Math.min(1, age / discharge.travel);
      const fade = age <= discharge.travel ? 1 : Math.max(0, 1 - (age - discharge.travel) / (discharge.life - discharge.travel));
      const start = this.curvePoint(discharge.edge, reversed ? 1 : 0, new THREE.Vector3());
      const end = this.curvePoint(discharge.edge, reversed ? 0 : 1, new THREE.Vector3());
      const length = start.distanceTo(end);
      tangent.subVectors(end, start).normalize();
      normalA.set(0, 1, 0).cross(tangent);
      if (normalA.lengthSq() < 1e-4) normalA.set(1, 0, 0).cross(tangent);
      normalA.normalize();
      normalB.crossVectors(tangent, normalA);
      const flicker = Math.floor(now / 45);
      const bolt = discharge.kind === "bolt";
      for (let k = 0; k <= BOLT_SEGMENTS; k++) {
        const along = k / BOLT_SEGMENTS;
        this.curvePoint(discharge.edge, reversed ? 1 - along : along, path[k]!);
        if (bolt && k > 0 && k < BOLT_SEGMENTS) {
          const amplitude = length * 0.06 * Math.sin(Math.PI * along);
          path[k]!.addScaledVector(normalA, hash(discharge.seed, k, flicker) * amplitude)
            .addScaledVector(normalB, hash(discharge.seed + 17, k, flicker) * amplitude);
        }
      }
      const glowBase = slot * (BOLT_SEGMENTS + 2);
      if (bolt) {
        for (let k = 0; k < BOLT_SEGMENTS; k++) {
          const visible = (k + 1) / BOLT_SEGMENTS <= head + 1e-6 ? 1 : 0;
          const v = (slot * BOLT_SEGMENTS + k) * 2;
          linePosition.setXYZ(v, path[k]!.x, path[k]!.y, path[k]!.z);
          linePosition.setXYZ(v + 1, path[k + 1]!.x, path[k + 1]!.y, path[k + 1]!.z);
          lineAlpha.setX(v, visible * fade);
          lineAlpha.setX(v + 1, visible * fade);
        }
        for (let k = 0; k <= BOLT_SEGMENTS; k++) {
          const visible = k / BOLT_SEGMENTS <= head + 1e-6 ? 1 : 0;
          glowPosition.setXYZ(glowBase + k, path[k]!.x, path[k]!.y, path[k]!.z);
          glowAlpha.setX(glowBase + k, visible * fade * 0.35);
          glowSize.setX(glowBase + k, 0.09);
        }
      }
      // Bright spark at the travelling head (bolts) or a soft comet (thinking pulses).
      const headPoint = this.curvePoint(discharge.edge, reversed ? 1 - head : head, this.tmp);
      glowPosition.setXYZ(glowBase + BOLT_SEGMENTS + 1, headPoint.x, headPoint.y, headPoint.z);
      glowAlpha.setX(glowBase + BOLT_SEGMENTS + 1, bolt ? (head < 1 ? 1 : fade * 0.6) : 0.55 * Math.sin(Math.PI * head));
      glowSize.setX(glowBase + BOLT_SEGMENTS + 1, bolt ? 0.2 : 0.14);
    });
    for (const attribute of [linePosition, lineAlpha, glowPosition, glowAlpha, glowSize]) attribute.needsUpdate = true;
  }

  /** Screen positions (css px) of all nodes for the HTML label overlay. */
  project(width: number, height: number, out: ProjectedNode[]): ProjectedNode[] {
    out.length = 0;
    const graph = this.graph;
    if (!graph) return out;
    this.scene.updateMatrixWorld();
    const centre = this.tmp.set(0, 0, 0).applyMatrix4(this.spin.matrixWorld).applyMatrix4(this.camera.matrixWorldInverse).z;
    const world = new THREE.Vector3(), view = new THREE.Vector3();
    graph.nodes.forEach((node, index) => {
      world.set(node.x, node.y, node.z).applyMatrix4(this.spin.matrixWorld);
      // View space looks down -z: nearer than the centre means a larger z, i.e. depth < 0.
      const depth = centre - view.copy(world).applyMatrix4(this.camera.matrixWorldInverse).z;
      world.project(this.camera);
      out.push({ index, x: (world.x + 1) / 2 * width, y: (1 - world.y) / 2 * height, depth });
    });
    return out;
  }

  get memoryGraph(): VoiceMemoryGraph | null { return this.graph; }

  dispose(): void {
    this.setGraph(null);
    for (const object of [this.boltLines, this.boltGlow, this.dust]) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  }
}
