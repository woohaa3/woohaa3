// Package errs 是服务端错误的唯一定义。
//
// 一个错误值自带三样东西：传输码、稳定业务码、用户可见文案，外加可选的内部原因。
// 分类本身定义在 api/proto（编译期由 tools/generrors 生成本包的 ErrXxx 变量）；
// 运行时只有这一个类型：用 fmt.Errorf("%w") 加上下文，边界处 errors.As 取回。
package errs

import (
	"errors"

	"connectrpc.com/connect"
)

// Error 是服务端错误的统一实现。
//
// 为什么把 code/reason/message 放在值上而不是查表：错误发生在哪一层，那一层最清楚
// "这算什么失败"；记在值上，包装多少次都不会丢，边界原样取出即可。
type Error struct {
	code    connect.Code
	reason  string
	message string
	cause   error
}

// New 创建一个业务错误。
func New(code connect.Code, reason, message string) *Error {
	return &Error{code: code, reason: reason, message: message}
}

// Wrap 在已有错误外面补一层分类；cause 留在错误链里，只进日志。
func Wrap(err error, code connect.Code, reason, message string) *Error {
	return &Error{code: code, reason: reason, message: message, cause: err}
}

// Code 返回传输码。
func (e *Error) Code() connect.Code { return e.code }

// Reason 返回稳定业务码。
func (e *Error) Reason() string { return e.reason }

// Message 返回用户可见文案。
func (e *Error) Message() string { return e.message }

// Error 只用于日志：对外文案由 Message 决定，内部原因跟在后面。
func (e *Error) Error() string {
	if e.cause != nil {
		return e.message + ": " + e.cause.Error()
	}
	return e.message
}

// Unwrap 让 errors.Is / errors.As 能继续向下走。
func (e *Error) Unwrap() error { return e.cause }

// From 从任意错误里取出我们定义的错误值（沿错误链）。
func From(err error) (*Error, bool) {
	var target *Error
	if errors.As(err, &target) {
		return target, true
	}
	return nil, false
}

// Is 按稳定业务码判断，供跨包使用：调用方不需要知道对方包里的变量名。
func Is(err error, reason string) bool {
	target, ok := From(err)
	return ok && target.reason == reason
}

// ReasonOf 取稳定业务码，取不到返回空串（日志与测试用）。
func ReasonOf(err error) string {
	if target, ok := From(err); ok {
		return target.reason
	}
	return ""
}

// Internal 是未分类错误的兜底：对外固定文案，原因留在链里。
func Internal(err error) *Error {
	return Wrap(err, connect.CodeInternal, "internal.unexpected", "服务暂时不可用")
}
