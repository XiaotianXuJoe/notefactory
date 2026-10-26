FROM mirror.ccs.tencentyun.com/library/node:20-bookworm
WORKDIR /app
COPY dist /app/dist
ENV NODE_ENV=production
EXPOSE 8300
CMD ["node", "dist/boot.js"]
