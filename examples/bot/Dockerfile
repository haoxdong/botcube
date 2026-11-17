# syntax=docker/dockerfile:1
# The example bot's image: BotCube's Harness image plus the bot's settings and skills (ADR 0091). It runs no bot code.
# Build context: botcube/examples/bot/. The `harness` build context names the Harness image, e.g.
#   docker build --build-context harness=docker-image://botcube-harness botcube/examples/bot
# A bot with CLIs installs them here too, on the PATH.
FROM harness
COPY bot.json /opt/bot/bot.json
COPY skills/ /opt/bot/skills/
ENV BOTCUBE_BOT_SETTINGS=/opt/bot/bot.json
