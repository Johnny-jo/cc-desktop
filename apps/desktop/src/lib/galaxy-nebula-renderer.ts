import { createGalaxyNebula } from "./galaxy-nebula";
import { INCLINATION_COS, PATTERN_SPEED, POSITION_ANGLE } from "./galaxy-particles";

type View = { x: number; y: number; radius: number; width: number; height: number; dpr: number; seconds: number };

const vertex = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0., 1.); }`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 viewport;
uniform vec2 center;
uniform float radius;
uniform float phase;
out vec4 color;

vec2 gradient(vec2 p) {
  vec2 h = vec2(dot(p, vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
  return -1. + 2. * fract(sin(h) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(dot(gradient(i), f), dot(gradient(i+vec2(1,0)), f-vec2(1,0)), u.x),
    mix(dot(gradient(i+vec2(0,1)), f-vec2(0,1)), dot(gradient(i+1.), f-1.), u.x), u.y);
}
// Rotated gradient noise avoids the square cells of the previous value noise.
float fbm(vec2 p) {
  float value = 0., amplitude = .5;
  mat2 turn = mat2(.8, -.6, .6, .8);
  for (int i=0; i<5; i++) {
    value += amplitude * noise(p);
    p = turn * p * 2.03 + vec2(7.1,13.7);
    amplitude *= .52;
  }
  return value;
}
mat2 rotation(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }
void main() {
  vec2 screen = vec2(gl_FragCoord.x, viewport.y-gl_FragCoord.y);
  vec2 p = rotation(${-POSITION_ANGLE}) * (screen-center) / radius;
  p.y /= ${INCLINATION_COS};
  p = rotation(-phase) * p;
  float r = length(p);
  if (r >= 1.) { color = vec4(0.); return; }
  float spiral = -1.3 + 3.05*log(1.+r*4.5);
  float angle = atan(p.y,p.x) - spiral;
  vec2 warp = vec2(fbm(p*17.+31.), fbm(p*17.-19.));
  float cloud = fbm(p*58. + warp*3.);
  float armAngle = angle + warp.x*.24;
  float arm = exp(-pow(sin(armAngle)/.3, 2.));
  float skirt = exp(-pow(sin(armAngle)/.65, 2.));

  // Tangentially stretched, domain-warped filaments, with smaller branching threads.
  vec2 flow = vec2(r*145., sin(angle+.12)*23.);
  float strands = fbm(flow + warp*4. + cloud*1.5);
  float thread = 1.-smoothstep(.008,.055,abs(strands + cloud*.2));
  float branch = 1.-smoothstep(.008,.065,abs(noise(flow*2.7+warp*5.)+.12));
  float lane = exp(-pow(sin(armAngle+.16)/.25,2.));
  float broken = smoothstep(-.25,.19, cloud+warp.y*.4);
  float dust = lane * (.65*thread+.35*branch) * (.2+broken*.8) * .7
    * smoothstep(.025,.16,r);
  float edge = 1.-smoothstep(.78,1.,r);
  float core = exp(-pow(r/.095,.95));
  float haze = exp(-r*3.7) * (.075 + skirt*.045);
  float clouds = arm * exp(-r*1.65) * (.1 + .52*smoothstep(-.2,.28,cloud));
  float knots = pow(smoothstep(.02,.36,cloud),3.) * arm * .12;
  vec3 emission = vec3(1.,.88,.72)*core*.8
    + vec3(.58,.66,.78)*haze
    + mix(vec3(.58,.67,.81), vec3(.85,.86,.85), core)*clouds
    + vec3(.57,.76,1.)*knots;
  // Wavelength-dependent extinction leaves warm brown translucent dust, not black ink.
  emission *= exp(-dust*vec3(1.1,1.8,2.6));
  // Subpixel grain breaks 8-bit banding; highest octave fades before it can shimmer.
  float footprint = max(length(dFdx(p)),length(dFdy(p)));
  float fine = noise(p*650.+warp*2.) * (1.-smoothstep(.0005,.0025,footprint));
  emission *= 1.+fine*.2;
  emission *= edge;
  float dither = fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5;
  emission = max(vec3(0.),emission+dither/255.);
  // Canvas compositing expects premultiplied light, leaving the app background visible.
  color = vec4(emission,clamp(max(emission.r,max(emission.g,emission.b)),0.,1.));
}`;

/** Evaluate dust at viewport resolution, so zoom never magnifies a fixed bitmap. */
export function createGalaxyNebulaRenderer() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, preserveDrawingBuffer: true });
  let fallback: HTMLCanvasElement | undefined;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const shaders: WebGLShader[] = [];
  if (gl) {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) break;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
    }
    if (shaders.length === 2 && shaders.every(shader => gl.getShaderParameter(shader, gl.COMPILE_STATUS))) {
      program = gl.createProgram();
      if (program) {
        shaders.forEach(shader => gl.attachShader(program!, shader));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); program = null; }
      }
    }
    if (program) {
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    }
  }
  const uniforms = gl && program ? {
    viewport: gl.getUniformLocation(program, "viewport"), center: gl.getUniformLocation(program, "center"),
    radius: gl.getUniformLocation(program, "radius"), phase: gl.getUniformLocation(program, "phase"),
  } : undefined;
  return {
    draw(context: CanvasRenderingContext2D, view: View) {
      if (gl && program && uniforms && !gl.isContextLost()) {
        // Bound fragment work on large/HiDPI windows while sampling only the visible area.
        const scale = Math.min(view.dpr, Math.sqrt(2_500_000 / Math.max(1,view.width*view.height)));
        const width = Math.max(1, Math.round(view.width*scale));
        const height = Math.max(1, Math.round(view.height*scale));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0,0,width,height);
        gl.uniform2f(uniforms.viewport,width,height);
        gl.uniform2f(uniforms.center,view.x*scale,view.y*scale);
        gl.uniform1f(uniforms.radius,view.radius*scale);
        gl.uniform1f(uniforms.phase,(view.seconds+14.42)*PATTERN_SPEED);
        gl.drawArrays(gl.TRIANGLES,0,3);
        context.drawImage(canvas,0,0,view.width,view.height);
      } else {
        // Software-only systems retain the scene and its lifecycle without WebGL.
        fallback ??= createGalaxyNebula();
        context.save();
        context.translate(view.x,view.y);
        context.rotate(POSITION_ANGLE);
        context.scale(1,INCLINATION_COS);
        context.rotate((view.seconds+14.42)*PATTERN_SPEED);
        context.drawImage(fallback,-view.radius,-view.radius,view.radius*2,view.radius*2);
        context.restore();
      }
    },
    dispose() {
      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        shaders.forEach(shader => gl.deleteShader(shader));
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}
