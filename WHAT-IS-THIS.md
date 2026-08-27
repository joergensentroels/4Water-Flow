# What is this?

> **This is the simple version.** It rounds off corners and leaves things out on purpose.
> The precise version is in [README.md](README.md), and how to run it is in
> [RUNBOOK.md](RUNBOOK.md).

## In one sentence

It is the thing that replaced the volunteer rota spreadsheet — you say when you can help, and
it works out who is teaching what.

It is built for a phone, because the complaint about the spreadsheet was that it was a
nightmare to use on one.

<p align="center">
  <img src="docs/plain-home.png" width="31%" alt="Home: how many dates still need an answer, and your upcoming slots">
  <img src="docs/plain-availability.png" width="31%" alt="Availability: each date with a yes, no, or not-answered choice">
  <img src="docs/plain-board.png" width="31%" alt="Shift exchange: slots other people have given up, each with a take-this-slot button">
</p>

## If you are a volunteer

**There is nothing to install and no password to make.** You get an invitation link, you open
it, and you are in.

Three things you can do:

**Say when you can help.** Tick a whole day, or open it up and answer each time separately.
You can change your mind later.

**See what you are on for.** Your upcoming slots are the first thing on the front page.

**Swap a shift.** Can't make one? Put it on the exchange. Want an extra? Take one off it.

```mermaid
flowchart TD
  A["You mark when you can help"] --> B["The planner builds the roster<br/>from everyone's answers"]
  B --> C["Your slots appear on your front page"]
  C --> D{"Can you still make it?"}
  D -- "yes" --> E["You turn up and teach"]
  D -- "no" --> F["Put it on the shift exchange"]
  F --> G["Someone else picks it up"]
```

## Yes, no, and not answered yet

There are three answers, not two — and the third one is the reason nobody gets signed up by
accident:

```mermaid
flowchart TD
  A["A date that needs an answer"] --> B{"Can you help?"}
  B -- "yes" --> C["You can be put on a shift"]
  B -- "no" --> D["You are not asked about<br/>that date again"]
  B -- "not answered yet" --> E["You get a reminder —<br/>never a shift"]
```

Silence is never read as agreement. Saying *no* is a real answer too, so you are not pestered
about a date you have already turned down.

## If you are the one making the rota

You get the season plan, a draft roster the app fills in for you, and the admin screens. It
knows who can teach what, that each class needs someone on the booth, and who has already said
no.

## If you are another organisation

Nothing about this is specific to us. The activities, the weekly rhythm, the times and every
word on screen come from configuration files, not from the code — so adapting it means editing
settings, not programming. A test fails the build if anything of ours leaks into the code.

## Setting it up

The easy part of this project. It runs straight from a copy of the code — no installer, no
build step, and nothing to download beyond the code itself. You need Node 22.13 or newer.

[RUNBOOK.md](RUNBOOK.md) covers running it properly, backups, and handing it to someone else.

## More

[README.md](README.md) · [How to run it](RUNBOOK.md) · Licence: AGPL-3.0-or-later
