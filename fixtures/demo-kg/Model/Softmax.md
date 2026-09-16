---
schema_version: '1.1'
type: concept
title: Softmax
aliases: ["归一化指数函数"]
summary: Softmax 将有限实数向量映射为正数且总和为一的向量。
---

# Softmax

> Softmax 将有限实数向量映射为正数且总和为一的向量。

## 核心想法

第 i 个输出为 exp(zᵢ)/Σ exp(zⱼ)。数值实现通常先减去最大输入以改善稳定性。

## 关系网络

- 相关：[[概率分布]] — 对照这个概念理解定义和条件。
- 相关：[[注意力机制]] — 沿关系继续探索。

## 示例说明

这是 Living Memory 的简短演示材料，用于验证导入、图谱与时间记录；不是从个人 progressive-kg 复制的学习笔记，也不包含任何真实学习历史。
