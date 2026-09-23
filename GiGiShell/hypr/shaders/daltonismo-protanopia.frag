#version 300 es
// Corrección (no simulación) para protanopia.
// Matriz derivada del algoritmo de daltonización de ChromeOS:
// chromium/src/ash/color_enhancement/color_enhancement_controller.cc
precision highp float;

in vec2 v_texcoord;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tex;

const mat3 CORRECCION = mat3(
    1.00000,  0.47463,  0.58933,
    0.00000,  0.48245, -0.67845,
    0.00000,  0.04299,  1.08999
);

void main() {
    vec4 color = texture(tex, v_texcoord);
    fragColor = vec4(clamp(CORRECCION * color.rgb, 0.0, 1.0), color.a);
}
