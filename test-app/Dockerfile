FROM denoland/deno:2.1.4

WORKDIR /app
COPY . .
RUN deno cache main.ts

EXPOSE 8080
CMD ["deno", "run", "--allow-net", "main.ts"]
