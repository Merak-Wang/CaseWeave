"""校验本地 JSON Schema，同时禁止通过 Schema 发起网络资源解析。"""
from jsonschema import Draft202012Validator


def check_schema(schema):
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                # 引用只允许指向当前文档片段，禁止加载外部 URL 或文件。
                if key in ("$ref", "$dynamicRef") and (not isinstance(item, str) or not item.startswith("#")):
                    raise ValueError("Only local schema references are supported")
                # 禁止声明新资源标识，避免改变引用基址后绕过本地引用限制。
                if key == "$id":
                    raise ValueError("Schema resource identifiers are not supported")
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    # 先递归执行安全约束，再交给 Draft 2020-12 校验 Schema 自身合法性。
    visit(schema)
    Draft202012Validator.check_schema(schema)
