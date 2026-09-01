#include <QtTest>

#include "RpcCodec.h"

class RpcCodecTest final : public QObject {
  Q_OBJECT

private slots:
  void decodesFragmentedNdjson();
};

void RpcCodecTest::decodesFragmentedNdjson() {
  RpcCodec codec;
  QCOMPARE(codec.feed(QByteArrayLiteral("{\"jsonrpc\":\"2.0\",\"method\":\"stream/text\",\"params\":{\"delta\":\"")), QList<QJsonObject>{});
  const QList<QJsonObject> messages = codec.feed(QString::fromUtf8("中文\"}}\n"));
  QCOMPARE(messages.size(), 1);
  QCOMPARE(messages.constFirst().value("method").toString(), QStringLiteral("stream/text"));
  QCOMPARE(messages.constFirst().value("params").toObject().value("delta").toString(), QStringLiteral("中文"));
}

QTEST_MAIN(RpcCodecTest)
#include "tst_rpc_codec.moc"
