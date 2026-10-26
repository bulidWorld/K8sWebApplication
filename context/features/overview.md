# 服务概述
这是一个k8s网页端运维服务

## 部署形态
- 部署在k8s 的master节点
- 使用 kubeconfig 连接 Kubernetes API Server
- 底层通过 Kubernetes API 读取集群资源，不调用 kubectl

## 技术栈
- 用React架构，前后端一体

## 功能规划
- 支持查看节点状态
- 支持查看命名空间
- 支持搜索筛选
- 支持查看日志
- 等等常用的功能
