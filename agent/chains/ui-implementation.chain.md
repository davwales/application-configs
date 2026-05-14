---
name: ui-implementation
description: A chain for implementing UI/frontend changes where the designer dictates style and direction, then the worker implements. Use for any frontend styling, layout, visual polish, or component work.
---

## designer
output: design-direction.md
outputMode: file-only

Analyze the following UI task and provide detailed design direction including: specific styles, colors, typography, layout, animations, and component structure. Be concrete with Tailwind classes, CSS properties, and visual specifications.\n\nTask: {task}

## worker
reads: design-direction.md

Implement the UI changes according to the design direction below. Follow the designer specifications exactly for styling, layout, colors, typography, and animations. The design direction is your blueprint - implement it faithfully.\n\nOriginal task: {task}\n\nDesign direction:\n{previous}
