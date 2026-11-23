# The example bot's image: BotCube's Harness image plus the bot's settings and skills (ADR 0091). It runs no bot code.
# Build context: botcube/. The `harness` build context names the Harness image, e.g.
#   docker build --build-context harness=docker-image://botcube-harness -f botcube/examples/bot/Dockerfile botcube
# A bot with CLIs installs them here too, on the PATH.
FROM harness
COPY examples/bot/bot.yaml /bot/bot.yaml
COPY examples/bot/skills/ /bot/skills/
COPY examples/public/botcube.yaml /opt/botcube/examples/public/botcube.yaml
COPY examples/enterprise/botcube.yaml /opt/botcube/examples/enterprise/botcube.yaml
