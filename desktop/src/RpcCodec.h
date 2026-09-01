#pragma once

#include <QJsonObject>
#include <QList>
#include <QString>

class RpcCodec final {
public:
  static constexpr qsizetype MaxLineBytes = 1'048'576;

  QList<QJsonObject> feed(const QByteArray &bytes);
  QList<QJsonObject> feed(const QString &text);
  bool finish();
  bool failed() const;
  QString errorString() const;
  static QByteArray encode(const QJsonObject &message);

private:
  QList<QJsonObject> fail(const QString &error);
  QByteArray pending_;
  QString error_;
};
