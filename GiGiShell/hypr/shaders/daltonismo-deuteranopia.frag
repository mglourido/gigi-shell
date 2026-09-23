#version 300 es
// Corrección (no simulación) para deuteranopia.
// Matriz derivada del algoritmo de daltonización de ChromeOS:
// chromium/src/ash/color_enhancement/color_enhancement_controller.cc
precision highp float;

in vec2 v_texcoord;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tex;

const mat3 CORRECCION = mat3(
     1.42620,  0.00000, -0.18180,
    -0.61786,  1.00000,  0.31294,
     0.19153,  0.00000,  0.92673
);

void main() {
    vec4 color = texture(tex, v_texcoord);
    fragColor = vec4(clamp(CORRECCION * color.rgb, 0.0, 1.0), color.a);
}
