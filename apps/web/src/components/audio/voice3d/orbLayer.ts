import * as THREE from "three";
import { ECHO_LENGTH, HISTORY_LENGTH, SPECTRUM_SIZE, WAVE_SIZE, type VoiceAudioFeatures } from "./audioFeatures";

/**
 * Audio rows uploaded once per frame and sampled in vertex shaders:
 * 0 active wave, 1 active spectrum, 2 energy echoes, 3-5 mic history (old->new),
 * 6-8 agent history (old->new).
 */
const AUDIO_ROWS = 3 + HISTORY_LENGTH * 2;
const row = (index: number) => (index + 0.5) / AUDIO_ROWS;

export class AudioTexture {
  readonly data = new Uint8Array(WAVE_SIZE * AUDIO_ROWS);
  readonly texture = new THREE.DataTexture(this.data, WAVE_SIZE, AUDIO_ROWS, THREE.RedFormat, THREE.UnsignedByteType);

  constructor() {
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  update(features: VoiceAudioFeatures): void {
    const { data } = this;
    data.set(features.wave, 0);
    data.set(features.spectrum, WAVE_SIZE);
    data.fill(0, WAVE_SIZE + SPECTRUM_SIZE, WAVE_SIZE * 2);
    for (let i = 0; i < ECHO_LENGTH; i++) data[WAVE_SIZE * 2 + i] = Math.min(255, features.echoes[i]! * 255);
    features.inputHistory.forEach((wave, i) => data.set(wave, WAVE_SIZE * (3 + i)));
    features.outputHistory.forEach((wave, i) => data.set(wave, WAVE_SIZE * (3 + HISTORY_LENGTH + i)));
    this.texture.needsUpdate = true;
  }

  dispose(): void { this.texture.dispose(); }
}

const SHARED_GLSL = /* glsl */ `
  uniform sampler2D uAudio;
  uniform float uTime;
  uniform float uRotation;
  uniform float uReduced;
  float audioAt(float u, float rowV) { return texture2D(uAudio, vec2(u, rowV)).r; }
  float waveAt(float u, float rowV) { return (audioAt(u, rowV) * 255.0 - 128.0) / 128.0; }
`;

const PARTICLE_VERTEX = /* glsl */ `
  ${SHARED_GLSL}
  uniform float uEnergy, uBass, uMids, uHighs, uThinking, uPointScale;
  attribute float aAngle;
  attribute float aAzimuth;
  varying vec3 vColor;
  varying float vAlpha;
  vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }
  void main() {
    vec3 p = position;
    float longitude = (aAzimuth + 3.14159265) / 6.2831853;
    float band = min(400.0, floor(pow(2.0, longitude * 8.5)));
    float frequency = audioAt((band + 0.5) / 1024.0, ${row(1).toFixed(6)});
    float wv = waveAt((floor(longitude * 1023.0) + 0.5) / 1024.0, ${row(0).toFixed(6)});
    float echo = audioAt((floor((p.y + 1.0) * 39.0) + 0.5) / 1024.0, ${row(2).toFixed(6)});
    float t = uTime;
    float ripple = sin(aAzimuth * 5.0 + p.y * 9.0 - t * 1.8) * 0.045
      + cos(aAzimuth * 3.0 - p.y * 13.0 + t) * 0.025
      + sin(aAngle * 7.0 + t * 0.8) * 0.012;
    float working = uThinking * sin(p.y * 16.0 - t * 4.0 + aAngle) * 0.045;
    // Reduced motion calms the shell (~40 %) instead of freezing it: the voice reaction is feedback, not decoration.
    float live = 1.0 - uReduced * 0.6;
    float deformation = 1.0 + ripple + live * (working + uBass * 0.13 + wv * (0.48 + uMids * 0.2)
      + frequency * 0.15 + sin(p.y * 24.0 - t * 5.0 + aAzimuth * 2.0) * echo * 0.13);
    float twist = live * (wv * 0.24 + sin(p.y * 8.0 + t) * uMids * 0.16);
    float cs = cos(uRotation), sn = sin(uRotation);
    float x = (p.x * cs + p.z * sn + p.y * twist) * deformation;
    float z = (p.z * cs - p.x * sn + p.x * twist) * deformation;
    float y = p.y * deformation;
    float perspective = 3.8 / (3.8 - z);
    gl_Position = vec4(x * 0.63 * perspective, -y * 0.63 * perspective, 0.0, 1.0);
    float edge = pow(1.0 - abs(p.z), 3.0);
    vAlpha = min(1.0, (z < 0.0 ? 0.12 : 0.55) + edge * 0.2 + uEnergy * 0.18 + frequency * uHighs * 0.4);
    // Cyan crown, violet middle, hot coral base.
    float hue = p.y < -0.15 ? 195.0 + (p.y + 1.0) * 75.0 : 260.0 + (p.y + 0.15) * 108.0;
    vColor = hsl2rgb(mod(hue, 360.0) / 360.0, 0.95, 0.6 + frequency * 0.2);
    float radius = 0.45 + (z + 1.0) * 0.3 + frequency * 0.9;
    gl_PointSize = max(1.0, radius * uPointScale * 2.6);
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float d = dot(c, c);
    if (d > 1.0) discard;
    float soft = (1.0 - d) * (1.0 - d);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

const RIBBON_VERTEX = /* glsl */ `
  ${SHARED_GLSL}
  uniform float uRow, uLatitude, uLift;
  attribute float aT;
  void main() {
    float theta = aT * 6.2831853;
    float wv = waveAt((floor(aT * 1023.0) + 0.5) / 1024.0, uRow);
    float waveHeight = (1.0 - uReduced * 0.6) * wv * 0.65;
    float r = sqrt(1.0 - uLatitude * uLatitude) + abs(waveHeight) * 0.16;
    float x = cos(theta) * r, z = sin(theta) * r, y = uLatitude + waveHeight + uLift;
    float cs = cos(uRotation), sn = sin(uRotation);
    float rx = x * cs + z * sn, rz = z * cs - x * sn;
    float perspective = 3.8 / (3.8 - rz);
    gl_Position = vec4(rx * 0.63 * perspective, -y * 0.63 * perspective, 0.0, 1.0);
  }
`;

const SCOPE_VERTEX = /* glsl */ `
  ${SHARED_GLSL}
  uniform float uRow, uOffset;
  attribute float aT;
  void main() {
    float wv = waveAt((floor(aT * 255.0) * 4.0 + 0.5) / 1024.0, uRow);
    float x = 0.23 + aT * 0.54;
    float y = 0.91 + uOffset + wv * 0.07;
    gl_Position = vec4(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  }
`;

const LINE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() { gl_FragColor = vec4(uColor, uAlpha); }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform float uEnergy;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    // Dark core keeps the orb readable over the wiki backdrop; violet rim breathes with energy.
    float core = (1.0 - smoothstep(0.5, 0.98, r)) * 0.9;
    float rim = exp(-pow((r - 0.66) * 4.2, 2.0)) * (0.22 + uEnergy * 0.3);
    vec3 color = mix(vec3(0.008, 0.012, 0.024), vec3(0.33, 0.12, 0.49), rim / max(0.001, core + rim));
    gl_FragColor = vec4(color, clamp(core + rim, 0.0, 1.0));
  }
`;

function fibonacciSphere(count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3), angles = new Float32Array(count), azimuths = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const y = 1 - (i + 0.5) / (count / 2);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    positions.set([Math.cos(angle) * radius, y, Math.sin(angle) * radius], i * 3);
    angles[i] = angle;
    azimuths[i] = Math.atan2(Math.sin(angle), Math.cos(angle));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aAngle", new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute("aAzimuth", new THREE.BufferAttribute(azimuths, 1));
  return geometry;
}

function lineGeometry(segments: number): THREE.BufferGeometry {
  const t = new Float32Array(segments + 1);
  for (let i = 0; i <= segments; i++) t[i] = i / segments;
  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; three still wants a position attribute.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((segments + 1) * 3), 3));
  geometry.setAttribute("aT", new THREE.BufferAttribute(t, 1));
  return geometry;
}

/**
 * The voice orb drawn entirely on the GPU: the particle shell deformation of the former
 * canvas renderer moved 1:1 into a vertex shader, so tens of thousands of particles cost
 * one draw call instead of tens of thousands of `ctx.arc()` calls per frame.
 */
export class OrbLayer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.Camera();
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly particleUniforms: Record<string, THREE.IUniform>;
  private readonly haloUniforms = { uEnergy: { value: 0 } };
  private readonly particles: THREE.Points;
  private particleCount = 0;
  private readonly lineMaterials: THREE.ShaderMaterial[] = [];

  constructor(audio: AudioTexture) {
    this.shared = { uAudio: { value: audio.texture }, uTime: { value: 0 }, uRotation: { value: 0 }, uReduced: { value: 0 } };
    this.particleUniforms = {
      ...this.shared,
      uEnergy: { value: 0 }, uBass: { value: 0 }, uMids: { value: 0 }, uHighs: { value: 0 },
      uThinking: { value: 0 }, uPointScale: { value: 1 },
    };

    const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.haloUniforms,
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: HALO_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false,
    }));
    halo.frustumCulled = false;
    halo.renderOrder = 0;
    this.scene.add(halo);

    this.particles = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.particleUniforms,
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 1;
    this.scene.add(this.particles);

    // Oscilloscope ribbons around the shell (mic above, agent below) with a short phosphor trail.
    const channels = [
      { color: new THREE.Color("rgb(103,232,249)"), latitude: -0.26, firstRow: 3 },
      { color: new THREE.Color("rgb(251,113,133)"), latitude: 0.26, firstRow: 3 + HISTORY_LENGTH },
    ];
    for (const channel of channels) {
      for (let trail = HISTORY_LENGTH - 1; trail >= 0; trail--) {
        this.addLine(new THREE.LineLoop(lineGeometry(384), this.lineMaterial(RIBBON_VERTEX, channel.color, {
          uRow: { value: row(channel.firstRow + HISTORY_LENGTH - 1 - trail) },
          uLatitude: { value: channel.latitude },
          uLift: { value: trail * 0.025 },
        }, trail ? 0.1 : 0.35)));
      }
    }
    // Flat traces under the orb: microphone above, agent output below.
    channels.forEach((channel, i) => {
      this.addLine(new THREE.Line(lineGeometry(255), this.lineMaterial(SCOPE_VERTEX, channel.color, {
        uRow: { value: row(channel.firstRow + HISTORY_LENGTH - 1) },
        uOffset: { value: i === 0 ? -0.012 : 0.012 },
      }, 0.65)));
    });
  }

  private lineMaterial(vertexShader: string, color: THREE.Color, uniforms: Record<string, THREE.IUniform>, alpha: number) {
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, ...uniforms, uColor: { value: color }, uAlpha: { value: alpha } },
      vertexShader, fragmentShader: LINE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    material.userData.baseAlpha = alpha;
    this.lineMaterials.push(material);
    return material;
  }

  private addLine(line: THREE.Line) {
    line.frustumCulled = false;
    line.renderOrder = 2;
    this.scene.add(line);
  }

  setParticleCount(count: number): void {
    if (count === this.particleCount) return;
    this.particleCount = count;
    this.particles.geometry.dispose();
    this.particles.geometry = fibonacciSphere(count);
  }

  update(features: VoiceAudioFeatures, seconds: number, reduced: boolean, viewportCssPx: number, pixelRatio: number): void {
    const t = reduced ? seconds * 0.4 : seconds;
    this.shared.uTime!.value = t;
    this.shared.uRotation!.value = t * (features.status === "thinking" ? 0.25 : 0.09);
    this.shared.uReduced!.value = reduced ? 1 : 0;
    const u = this.particleUniforms;
    u.uEnergy!.value = features.energy;
    u.uBass!.value = features.bass;
    u.uMids!.value = features.mids;
    u.uHighs!.value = features.highs;
    u.uThinking!.value = features.status === "thinking" ? 1 : 0;
    // Same "1 unit = width / 420 css px" sizing as the canvas version, in device pixels;
    // denser shells get slightly smaller points so overall brightness stays similar.
    u.uPointScale!.value = viewportCssPx / 420 * pixelRatio * Math.sqrt(11000 / Math.max(1, this.particleCount));
    this.haloUniforms.uEnergy.value = features.energy;
    const levels = [features.inputLevel, features.outputLevel];
    this.lineMaterials.forEach((material, i) => {
      const channel = i < HISTORY_LENGTH * 2 ? Math.floor(i / HISTORY_LENGTH) : i - HISTORY_LENGTH * 2;
      const base = material.userData.baseAlpha as number;
      material.uniforms.uAlpha!.value = i < HISTORY_LENGTH * 2 ? base + Math.min(levels[channel]! * 2, 0.45) : base;
    });
  }

  dispose(): void {
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
}
