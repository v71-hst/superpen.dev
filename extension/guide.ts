// Reference text returned by the get_guide tool.
export const GUIDE = `# .pen format and editing guide (Superpencil MCP)

## Workflow
1. list_open_files → select_file (takes the edit lock for this chat; opens the file if needed).
2. get_editor_state / get_tree to orient yourself; get_selection to see what the user picked.
3. apply_operations to edit (atomic batch = one undo step for the user).
4. screenshot the frame you changed and check_layout, then fix anything that looks wrong.
5. save_file when done if the user wants it saved. release_file if another chat needs the file.

## Document
{ "version": "2.21", "children": [ ...top-level nodes ], "variables": {...}, "themes": {...} }
Every node has "type" and a unique "id" (no "/"). Omit ids on insert and they are generated.
Top-level nodes are positioned on the canvas with x/y. Usually each screen is a top-level frame.

## Node types
frame      container. layout: "none" (children use x/y) | "vertical" | "horizontal" (default horizontal).
           gap, padding (n | [v,h] | [t,r,b,l]), justifyContent: start|center|end|space_between|space_around,
           alignItems: start|center|end, clip: true to hide overflow, cornerRadius (n | [tl,tr,br,bl]).
group      plain container without its own box.
rectangle, ellipse (innerRadius 0..1, startAngle, sweepAngle), polygon (polygonCount), line
path       geometry: SVG path data; viewBox [x,y,w,h] maps it onto width×height.
text       content, fontFamily (Google Fonts), fontSize, fontWeight ("400","600","bold"), lineHeight (multiplier),
           letterSpacing (px), textAlign, textAlignVertical, textGrowth:
             "auto" (no wrap; width/height ignored) | "fixed-width" (wraps, height grows) | "fixed-width-height".
icon       library: "lucide" | "feather" | "Material Symbols Outlined|Rounded|Sharp" | "phosphor", icon: name, fill: color.
note / prompt / context   annotation cards with content.
ref        component instance: { type: "ref", ref: "<component id>", descendants: { "<child id path>": { props } } }.

## Sizing
width/height: number | "fill_container" (stretch inside a vertical/horizontal parent) | "fit_content" (hug children).
Optional fallback: "fit_content(200)". Children of layout frames ignore x/y unless layoutPosition: "absolute".

## Paint
fill / stroke: "#RRGGBB" | "#RRGGBBAA" | "$variable" | array of paints (last paints on top) |
  { type: "gradient", gradientType: "linear"|"radial"|"angular", rotation (deg, CCW, 0 = up), colors: [{color, position 0..1}] } |
  { type: "image", url: "./relative.png", mode: "cover"|"contain"|"stretch" }.
strokeWidth (n or {top,right,bottom,left}), strokeAlignment: inner|center|outer.
effect: { type: "shadow", shadowType: "outer"|"inner", offset: {x,y}, blur, spread, color } | { type: "blur", radius } |
        { type: "background_blur", radius } — or an array of these.
opacity 0..1, rotation (deg CCW), flipX/flipY, enabled: false hides a node.

## Variables & themes
variables: { "brand": { "type": "color", "value": "#3366FF" } }. Reference anywhere as "$brand".
Themed values: "value": [ { "value": "#FFF" }, { "value": "#111", "theme": { "Mode": "Dark" } } ] with themes: { "Mode": ["Light","Dark"] }.

## Components
Mark any node reusable: true to make it a component. Instantiate with the "instantiate" op.
Nodes inside an instance have ids like "<instanceId>/<childId>"; "update" on such an id stores an override.
States (variants): on the component, states: { "hover": { "root": { props }, "descendants": { "<child id path>": { props } } }, "pressed": {...}, "disabled": {...} }.
An instance shows one with state: "hover". In Present mode "hover" and "pressed" play automatically under the mouse.

## Prototype links
Any node can have link: { "to": "<top-level frame id>" | "__back", "transition": "instant" | "dissolve" | "slide-left" | "slide-right" | "slide-up" | "slide-down" }.
Clicking it in Present mode navigates. Use this to wire up flows (buttons -> screens, back buttons -> "__back").

## Comments
The user can pin comments on the canvas. Tool results include a note when comments are waiting: read them with get_comments,
do what they ask, then reply_comment (optionally resolve: true).

## Sections
Files with many top-level frames should be organised into sections: named groups of top-level frames (one per feature
or area). create_section groups frames without moving them. Frames in hidden sections are not rendered, which keeps big
files fast, so hide what you are not working on: before working on one area, call focus_sections with the section(s)
you need (it hides the rest) and tell the user which sections you hid. Hidden frames can still be read, edited,
screenshotted and exported (export_node, screenshot, export_roblox all work on them). When you add new top-level frames
to a file that has sections, add them to the right section (update_section add_frame_ids). The user can also switch the
canvas to the Sections viewer, which shows one section at a time; tool notes say which section they are looking at.

## apply_operations
[
  { "op": "insert", "parent": "<frame id or null for top level>", "index": 0, "node": { "type": "frame", ... , "children": [...] } },
  { "op": "update", "id": "<id>", "props": { "fill": "#FF0000", "width": null } },   // null removes a property
  { "op": "delete", "id": "<id>" },
  { "op": "move", "id": "<id>", "parent": "<new parent>", "index": 2, "x": 10, "y": 20 },
  { "op": "duplicate", "id": "<id>", "props": { "x": 400 } },
  { "op": "replace", "id": "<id>", "node": { ...full node... } },
  { "op": "instantiate", "component": "<component id>", "parent": "<frame>", "props": { "x": 0 }, "overrides": { "<childId>": { "content": "Buy" } } }
]
If any operation is invalid the whole batch is rejected and nothing changes.

## Vector artwork (insert_svg / vectorize_image)
For logos, icons and illustrations, write SVG markup and call insert_svg (frame of editable path nodes, scaled to
width×height). Keep it clean: a viewBox, flat fills or simple gradients, no text (add text nodes separately).
Turn artwork you reuse into a component (reusable: true on the frame) instead of inserting copies.
vectorize_image traces an image fill into paths (good for flat logos, poor for photos).
Prefer icon nodes for standard UI icons and frames/shapes/gradients for decoration; use SVG for custom artwork.

## Scripts (generated content)
A script node runs a JavaScript file and draws the nodes it returns inside its box:
{ "type": "script", "scriptUri": "./scripts/bars.js", "width": 400, "height": 300, "inputs": { "count": 8 }, "clip": true }
Write the file with write_asset. It must start with a header declaring the schema and inputs:
/**
 * @schema 2.11
 * @input count: number(min=1, max=50) = 12
 * @input color: color = #3B82F6
 * @input label: string = "Sales"
 * @input filled: boolean = true
 * @input style: enum("bars", "dots") = "bars"
 * @input item: ref            // id of a component; emit { type: "ref", ref: pencil.input.item, ... }
 */
The body gets pencil.width, pencil.height and pencil.input.<name>, and must \`return\` an array of .pen nodes
positioned inside 0..width × 0..height. Math.random() is seeded per node, so output is stable. No DOM/network access.
Generated nodes are read-only: change inputs (apply_operations update on the script node) or the script file.

## Shaders (WebGL 1.0 fragment shaders)
Shader fill:   "fill": { "type": "shader", "url": "./shaders/silk.glsl", "uniforms": { "u_speed": 0.5 } }
Shader effect: "effect": { "type": "shader", "url": "./shaders/pixelate.glsl", "uniforms": { ... } }  (post-processes the node)
gl_FragCoord is in node coordinates (origin top-left, y down, node units). textureSize(sampler, 0) is available.
Uniform annotations go in a /** */ comment right above each uniform:
  @resolution (vec2 node size) · @time (float seconds, animates) · @mouse (vec2 pointer position)
  @sdf (sampler2D: r = signed distance, positive inside; gb = gradient direction) · @content (sampler2D: the node's
  own rendering below the shader; for effects the whole node) · @backdrop (sampler2D: what is behind the node)
  @mipmap · @color (color picker for vec3/vec4) · @default <value> · @range <min>, <max> · @label <name>
sampler2D uniforms without a special tag take an image path (relative to the .pen file) as their value.
Example:
/** @resolution */ uniform vec2 u_resolution;
/** @content */ uniform sampler2D u_content;
/**
 * @label Pixel Size
 * @default 8
 * @range 1, 64
 */
uniform float u_pixelSize;
void main() {
  vec2 cell = (floor(gl_FragCoord.xy / u_pixelSize) + 0.5) * u_pixelSize;
  gl_FragColor = texture2D(u_content, cell / u_resolution);
}
Output is premultiplied alpha (like gl_FragColor in pen.dev). Screenshot after writing a shader: compile errors are shown on the node
and reported by check_layout.

## Tips
- Prefer layout frames (vertical/horizontal + gap/padding) and fill_container over absolute x/y for UI.
- Reuse existing variables and components (get_variables, list_components) to match the design system.
- Keep names meaningful: the user sees them in the layers panel.
- Always screenshot after visual changes.
`;
