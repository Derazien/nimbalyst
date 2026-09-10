---
name: excalidraw
description: Create diagrams and visual drawings using Excalidraw (.excalidraw files). Use when the user wants flowcharts, architecture diagrams, system diagrams, sketches, or any visual diagram. For database schemas and entity relationship diagrams, use the DataModelLM extension instead.
---

# Excalidraw Diagrams

Excalidraw is Nimbalyst's whiteboard-style diagram editor for creating flowcharts, architecture diagrams, system diagrams, and visual sketches.

## STOP AFTER ONE PASS: Do Not Thrash

The single biggest failure mode with this skill is agents creating a diagram, capturing a screenshot, noticing minor cosmetic imperfections, then clearing and rebuilding the diagram two, three, or four times without being asked. This is the wrong behavior. The user sees every rebuild, and iterations the user did not ask for are a waste of their time and attention.

Follow these rules:

1. **One-shot by default.** Build the diagram, call `excalidraw.fit_to_text` once, capture a screenshot once, describe what you made, and stop. Do not iterate on visual polish unless the user explicitly asks for a change.
2. **Never use `excalidraw.clear_all` followed by a rebuild as a way to "redo" the diagram.** `clear_all` is only for user-requested rebuilds. If you just produced a diagram, looked at it, and feel like starting over, don't. Stop and hand control back to the user.
3. **Minor imperfections are fine.** Excalidraw is a whiteboard / hand-drawn-style tool. Slight overlaps, arrows that route imperfectly, labels that aren't perfectly centered, and asymmetric spacing are all acceptable and expected. Do not rebuild to fix these. Do not re-run `import_mermaid` because the auto-layout isn't pixel-perfect.
4. **Only one screenshot per diagram.** Capture once to verify the diagram exists and is roughly what you intended, then stop screenshotting. Repeated screenshots drive perfectionism loops.
5. **If something is actually broken, make a targeted fix, not a rebuild.** Cramped or clipped text and overlapping boxes: `fit_to_text`. Anything else: `update_element`, `move_element`, `remove_element`, or `align_elements` on the specific problem. Do not wipe and restart.
6. **"Good enough to convey the idea" is the bar.** The diagram's job is to communicate structure or flow to a human reader. Once it does that, you are done. Do not keep polishing.

If you catch yourself about to call `clear_all` after just having built a diagram, or about to capture a second screenshot of the same diagram, stop. Report what you made and let the user decide whether changes are needed.

## When to Use Excalidraw

- Flowcharts and process diagrams
- Architecture diagrams
- System design diagrams
- Sequence diagrams
- Mind maps
- Network diagrams
- User flow diagrams
- General visual diagrams and sketches

## When NOT to Use Excalidraw

- **Database schemas / Entity relationship diagrams** - Use DataModelLM extension instead (creates `.datamodel` files with Prisma schema)

## File Format

- **Extension**: `.excalidraw`
- **Format**: JSON-based Excalidraw format
- **Location**: Any directory in the workspace

## Available MCP Tools

The Excalidraw extension provides these MCP tools for diagram manipulation:

### Getting Information
- `excalidraw.get_elements` - Get all elements in the diagram

### Adding Elements
- `excalidraw.add_rectangle` - Add a rectangle/box
- `excalidraw.add_arrow` - Add a single arrow
- `excalidraw.add_arrows` - Add multiple arrows at once
- `excalidraw.add_elements` - Add multiple elements at once
- `excalidraw.add_frame` - Add a frame (container for elements)
- `excalidraw.add_row` - Add elements in a horizontal row
- `excalidraw.add_column` - Add elements in a vertical column

### Modifying Elements
- `excalidraw.update_element` - Update an existing element
- `excalidraw.move_element` - Move an element to new position
- `excalidraw.remove_element` - Remove a single element
- `excalidraw.remove_elements` - Remove multiple elements

### Organization
- `excalidraw.align_elements` - Align elements horizontally/vertically
- `excalidraw.distribute_elements` - Distribute elements evenly
- `excalidraw.group_elements` - Group elements together
- `excalidraw.set_elements_in_frame` - Put elements into a frame
- `excalidraw.fit_to_text` - Make every label fit its box and push overlapping boxes apart, for the whole board

### Special Features
- `excalidraw.import_mermaid` - Convert Mermaid syntax to Excalidraw
- `excalidraw.clear_all` - Clear all elements from the diagram

## Sizing: Make Text Fit on the First Try

The tools wrap every label inside its box with padding (16 px left and right, 12 px top and bottom), keep the width you ask for, and grow the box taller, never shorter, until the label fits. Every add tool returns the final width and height, and `add_elements` also lists any boxes that grew into a neighbour. You plan the layout; the tools make the text fit.

**Characters per line.** At the default font (20 px, the hand-drawn Excalifont), plan on 11 px per character for normal text and 14 px for ALL CAPS, after the 32 px of padding:

| Box width | Characters per line |
| --- | --- |
| 160 | about 10 |
| 200 | about 13 |
| 240 | about 18 |
| 300 | about 23 |
| 360 | about 29 |
| 440 | about 37 |
| 580 | about 50 |

**Height the box will reach.** 25 px per line plus 24 px: one line is 49, two lines 74, three 99, four 124, six 174. A 100-character label in a 300 px box is 5 lines, so the box becomes 149 px tall whatever height you asked for. Leave room for that when you place the next row.

**Keep labels short.** A box label is a name, not a paragraph: 2 to 6 words. Put explanation in one separate note box (a wide rectangle, 400 to 600 px) or in your chat reply, not inside every box. A box with 30 words in it is the main cause of cramped boards.

**Leave real gaps.** Between boxes, at least 40 px. Between two boxes joined by a labeled arrow, at least the label plus 40 px: about 60 px when stacked, and when side by side about 8 px per label character plus 40 (arrow labels are 16 px, so a 12-character label needs about 140 px). One short label per arrow (1 to 3 words); put anything longer in a note box.

**Use frames with margins.** Put each section in a frame (`add_frame`), keep content at least 30 px inside the frame edges, and leave at least 60 px between frames because the frame title sits above the frame.

**Then call `fit_to_text` once.** After adding the boxes and arrows, call `excalidraw.fit_to_text`. It waits for the drawing font, re-wraps every label, grows boxes that need it, pushes overlapping boxes down (keeping x positions, columns and existing gaps), widens the gap under a side-by-side arrow label, grows frames around their content, re-aims arrows and moves arrow labels off each other. It is also the fix for an existing board that looks cramped. Call it once; it does not need a second pass.

## Workflow

1. **Create file** - Create a new `.excalidraw` file or target an existing one. The file does not need to be open in Nimbalyst.
2. **Use MCP tools** - Pass the file path directly to the Excalidraw MCP tools. Nimbalyst mounts a hidden editor automatically; do not call `extension_test_open_file` first because it creates and focuses a visible tab.
3. **Build in batches** - Frames first, then all boxes in one `add_elements` call (sized with the table above), then all arrows in one `add_arrows` call, then `set_elements_in_frame`.
4. **Fit once** - Call `excalidraw.fit_to_text` a single time.
5. **Verify visually (once)** - Use `mcp__nimbalyst__capture_editor_screenshot` a single time to confirm the diagram rendered
6. **Stop** - Report what you made and hand control back. Do not iterate on polish unless the user asks for changes. See "STOP AFTER ONE PASS" above.

## Best Practices

- Use frames to group related elements
- Keep box labels to a few words and move prose into a note box
- Use consistent widths within a row and consistent spacing
- Add arrows to show flow/relationships, one short label per arrow
- Use color sparingly for emphasis

## Example: Creating a Flowchart

1. Add rectangles for each step in one `add_elements` call (200 to 240 px wide for 2 to 4 word labels, 60 px apart)
2. Add arrows connecting the steps in one `add_arrows` call
3. Call `fit_to_text` once
4. Use `align_elements` or `distribute_elements` only if the steps should line up and do not
