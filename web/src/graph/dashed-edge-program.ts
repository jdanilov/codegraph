/**
 * A dashed variant of sigma's curved-edge program.
 *
 * The contract renders `provenance: 'heuristic'` edges — the ones a dynamic
 * dispatch synthesizer inferred rather than the parser reading them — as dashed
 * lines. WebGL has no line-dash state, so this has to happen in a shader.
 *
 * Rather than reimplement the curve program (its bezier distance field is
 * genuinely subtle), we subclass it and patch one thing into the fragment
 * shader: a dash phase measured along the source→target chord. Because the
 * curvature is slight by design, chord distance is indistinguishable from true
 * arc length here, and it costs one dot product per fragment.
 *
 * The dash is skipped under `PICKING_MODE` so the gaps stay hoverable — an edge
 * you can only select on the ink is maddening.
 */
import { createEdgeCurveProgram } from '@sigma/edge-curve';
import type { Attributes } from 'graphology-types';
import type { EdgeProgramType } from 'sigma/rendering';

/** Edge attribute the curve program reads for per-edge curvature. */
export const CURVATURE_ATTRIBUTE = 'curvature';

/** Edge `type` values wired into sigma's `edgeProgramClasses`. */
export const CURVED_EDGE_TYPE = 'curved';
export const DASHED_EDGE_TYPE = 'curvedDashed';

/** Dash period and ink length, in device pixels. */
const DASH_PERIOD = 17.0;
const DASH_INK = 9.0;

const DASH_PROLOGUE = /* glsl */ `
  #ifndef PICKING_MODE
  vec2 dashAxis = v_cpC - v_cpA;
  float dashAxisLength = max(length(dashAxis), 1.0);
  float dashPhase = dot(gl_FragCoord.xy - v_cpA, dashAxis) / dashAxisLength;
  if (mod(dashPhase, ${DASH_PERIOD.toFixed(1)}) > ${DASH_INK.toFixed(1)}) discard;
  #endif
`;

const MAIN_SIGNATURE = 'void main(void) {';

function withDashes(fragmentShader: string): string {
  if (!fragmentShader.includes(MAIN_SIGNATURE)) return fragmentShader;
  return fragmentShader.replace(MAIN_SIGNATURE, `${MAIN_SIGNATURE}\n${DASH_PROLOGUE}`);
}

/** Solid curved edges — the default for every parsed relation. */
export function createCurvedEdgeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(): EdgeProgramType<N, E, G> {
  return createEdgeCurveProgram<N, E, G>({ curvatureAttribute: CURVATURE_ATTRIBUTE });
}

/** Dashed curved edges — synthesized (heuristic) relations. */
export function createDashedEdgeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(): EdgeProgramType<N, E, G> {
  const Base = createEdgeCurveProgram<N, E, G>({
    curvatureAttribute: CURVATURE_ATTRIBUTE,
  }) as unknown as new (...args: never[]) => {
    getDefinition(): { FRAGMENT_SHADER_SOURCE: string };
  };

  class DashedEdgeProgram extends Base {
    override getDefinition(): { FRAGMENT_SHADER_SOURCE: string } {
      const definition = super.getDefinition();
      return {
        ...definition,
        FRAGMENT_SHADER_SOURCE: withDashes(definition.FRAGMENT_SHADER_SOURCE),
      };
    }
  }

  return DashedEdgeProgram as unknown as EdgeProgramType<N, E, G>;
}
