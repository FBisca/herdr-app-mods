# herdr-app-mods

Layouts and mods for the [Herdr app](https://herdr.dev). One folder each, laid out like
`~/.config/herdr-app`, with a `RECIPE.md` (the brief to rebuild it) and a `preview.png`.

| Folder | What |
|---|---|
| [plans](plans/) | A Plans side panel beside Files and Changes: the shown space's `docs/plans/*.plan.md`, their tickets and the agents working on them |

## Install one

Copy its `layouts/` and `mods/` into `~/.config/herdr-app/` (rename on a clash), run
`herdr-app check ~/.config/herdr-app/mods/<mod>` for each mod, then
`herdr-app do layout.switch --name <layout>`. `ctrl-shift-l` switches back; deleting the
files removes it.

Or point your agent at the folder: Herdr's `AGENTS.md` describes how to add a shared layout.

`plans-tabs` and `plans-files` are modified clones of Herdr's shipped `tabs` and `files` mods.
