# 生产环境边界

- 项目：闭眼笔记工厂
- 端口：8300
- 目录：/home/ubuntu/notefactory
- 进程：Docker：notefactory + notefactory-db

## 推荐检查

`npm install；npm run check；npm run build`

## 不上传、不覆盖

数据库、LLM 设置、Cookie、data/ 和日志。这些内容只应通过独立的生产备份机制保存，不属于 Git 源码。

本仓库公开可见。任何真实凭据都不应写入代码、Issue、Actions 日志或 Git 历史。
