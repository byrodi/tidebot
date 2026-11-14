# Tidebot

A programming game where you write a script and a small fishing boat follows it.

**[Play in your browser](https://byrodi.github.io/tidebot/)**. There is nothing to install, and your progress is saved in the browser.

![Tidebot with a script in the editor, a boat on a 5 by 5 sea and the upgrade Workshop](.github/screenshot.png)

## How it plays

1. Press Run. The starter script fishes one cell and returns to the dock.
2. Wrap it in `while (true)` and the boat repeats the trip.
3. Unload the catch at the dock and buy upgrades in the Workshop.
4. Finish the tasks to unlock variables, functions and lists.
5. Build the lighthouse to win.

## Highlights

- A small JavaScript-like language with its own interpreter
- The running line is highlighted while the boat works
- Sardines, crab pots and moving tuna shoals
- A sea that grows from 3 by 3 to 8 by 8 cells

## Development

Playing needs none of this. To change the game, serve the folder and run the tests. There is no build step.

```bash
npm run serve
npm test
```

The server listens on http://localhost:8123.

## License

[MIT](LICENSE)
