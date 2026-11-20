# The example bot's image: BotCube's Harness image plus the bot's settings and skills (ADR 0091). It runs no bot code.
# Build context: botcube/examples/bot/. The `harness` build context names the Harness image, e.g.
#   docker build --build-context harness=docker-image://botcube-harness botcube/examples/bot
# A bot with CLIs installs them here too, on the PATH.
# The settings sit where the examples' Deployment Configs, at /opt/botcube/examples/<example>/, name them: ../bot/bot.json.
FROM harness
COPY bot.json /opt/botcube/examples/bot/bot.json
COPY skills/ /opt/botcube/examples/bot/skills/
