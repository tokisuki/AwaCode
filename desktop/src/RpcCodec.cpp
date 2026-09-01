#include "RpcCodec.h"

#include <QJsonDocument>
#include <QJsonParseError>

QList<QJsonObject> RpcCodec::feed(const QByteArray &bytes) {
  if (failed()) return {};
  pending_.append(bytes);
  QList<QJsonObject> messages;
  for (;;) {
    const qsizetype newline = pending_.indexOf('\n');
    if (newline < 0) {
      if (pending_.size() > MaxLineBytes) return fail(QStringLiteral("line_too_long"));
      return messages;
    }
    QByteArray line = pending_.left(newline);
    pending_.remove(0, newline + 1);
    if (line.endsWith('\r')) line.chop(1);
    if (line.trimmed().isEmpty()) continue;
    if (line.size() > MaxLineBytes) return fail(QStringLiteral("line_too_long"));
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(line, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) return fail(QStringLiteral("parse_error"));
    messages.append(document.object());
  }
}

QList<QJsonObject> RpcCodec::feed(const QString &text) {
  return feed(text.toUtf8());
}

bool RpcCodec::finish() {
  if (failed()) return false;
  if (!pending_.trimmed().isEmpty()) {
    fail(QStringLiteral("incomplete_line"));
    return false;
  }
  pending_.clear();
  return true;
}

bool RpcCodec::failed() const { return !error_.isEmpty(); }

QString RpcCodec::errorString() const { return error_; }

QByteArray RpcCodec::encode(const QJsonObject &message) {
  return QJsonDocument(message).toJson(QJsonDocument::Compact) + '\n';
}

QList<QJsonObject> RpcCodec::fail(const QString &error) {
  error_ = error;
  pending_.clear();
  return {};
}
